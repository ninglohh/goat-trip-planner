let places = [];
let friends = [];
let itinerary = [];
let skeleton = [];
let dayStartTimes = {};
let lastPlaceCoords = null;
let startingPointCoords = null;
let backendAvailable = false;
let currentDayView = 1;
let currentTripId = null;
let tripSaveTimeout = null;
const suggestionSearchTimeouts = {};

const TRAVEL_MODES = ['driving', 'transit', 'walking', 'bicycling'];
const TRAVEL_MODE_LABELS = { driving: 'driving', transit: 'transit', walking: 'walking', bicycling: 'cycling' };

const suggestionTargets = {
    place: {
        boxId: 'placeSuggestions',
        latest: [],
        onSelect(suggestion) {
            document.getElementById('placeName').value = suggestion.name;
            document.getElementById('placeAddress').value = suggestion.address || '';
            lastPlaceCoords = { lat: suggestion.lat, lng: suggestion.lng };
        }
    },
    startingPoint: {
        boxId: 'startingPointSuggestions',
        latest: [],
        onSelect(suggestion) {
            document.getElementById('startingPoint').value = suggestion.address || suggestion.name;
            startingPointCoords = { lat: suggestion.lat, lng: suggestion.lng };
        }
    }
};

async function checkBackendStatus() {
    try {
        const response = await fetch('/api/health');
        if (!response.ok) {
            updateApiStatus(false, 'backend unreachable. start itinerary_backend.py on port 5001.');
            return;
        }

        const data = await response.json();
        backendAvailable = true;

        if (data.apiKeyConfigured) {
            updateApiStatus(true, 'backend connected ✓ google maps api key detected.');
        } else {
            updateApiStatus(true, 'backend connected, but no google maps api key is set (GOOGLE_MAPS_API_KEY). place search/geocoding will fail.', true);
        }
    } catch (error) {
        backendAvailable = false;
        updateApiStatus(false, 'backend unreachable. start itinerary_backend.py on port 5001.');
    }
}

function updateApiStatus(loaded, message, warn = false) {
    const status = document.getElementById('apiStatus');
    if (!status) return;

    if (loaded) {
        status.textContent = message || 'backend connected ✓';
        status.classList.toggle('status-warn', warn);
        status.classList.toggle('status-ok', !warn);
        status.classList.remove('status-error');
    } else {
        status.textContent = message || 'backend unavailable. check the server and network.';
        status.classList.add('status-error');
        status.classList.remove('status-ok', 'status-warn');
    }
}

function getSuggestionsBox(target) {
    return document.getElementById(suggestionTargets[target].boxId);
}

function clearSuggestions(target) {
    const box = getSuggestionsBox(target);
    if (!box) return;
    box.classList.add('hidden');
    box.innerHTML = '';
}

function renderSuggestions(target, results) {
    const box = getSuggestionsBox(target);
    if (!box) return;
    const config = suggestionTargets[target];

    if (!results || results.length === 0) {
        box.innerHTML = '<div class="suggestion-item"><span class="suggestion-label">no results found</span></div>';
        box.classList.remove('hidden');
        config.latest = [];
        return;
    }

    config.latest = results;
    box.innerHTML = results.map((place, index) => `
        <button type="button" class="suggestion-item" onclick="selectSuggestionFor('${target}', ${index})">
            <span class="suggestion-label">${place.name}</span>
            <span class="suggestion-subtitle">${place.address || 'address unavailable'}</span>
        </button>
    `).join('');
    box.classList.remove('hidden');
}

async function searchSuggestions(target, query) {
    const box = getSuggestionsBox(target);
    if (!box) return;

    if (!query || query.length < 2) {
        clearSuggestions(target);
        return;
    }

    try {
        const response = await fetch('/api/place-search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query })
        });

        if (!response.ok) {
            clearSuggestions(target);
            return;
        }

        const data = await response.json();
        renderSuggestions(target, data.results || []);
    } catch (error) {
        clearSuggestions(target);
    }
}

function scheduleSuggestionSearch(target, query) {
    clearTimeout(suggestionSearchTimeouts[target]);
    suggestionSearchTimeouts[target] = setTimeout(() => {
        searchSuggestions(target, query);
    }, 250);
}

function selectSuggestionFor(target, index) {
    const config = suggestionTargets[target];
    const suggestion = config.latest[index];
    if (!suggestion) return;

    config.onSelect(suggestion);
    clearSuggestions(target);
}

async function geocodePlaceName(query) {
    const response = await fetch('/api/geocode', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ address: query })
    });

    if (!response.ok) {
        throw new Error('Geocoding failed');
    }

    const data = await response.json();
    return {
        formatted_address: data.formatted_address,
        geometry: {
            location: {
                lat: () => data.lat,
                lng: () => data.lng
            }
        }
    };
}

function toggleTagOption(button) {
    button.classList.toggle('active');
}

function collectSelectedTags() {
    const presetTags = Array.from(document.querySelectorAll('#placeTagOptions .tag-toggle.active'))
        .map(btn => btn.dataset.tag);
    const customTags = document.getElementById('placeCustomTag').value
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);

    return [...new Set([...presetTags, ...customTags])];
}

async function addPlace() {
    const name = document.getElementById('placeName').value.trim();
    let address = document.getElementById('placeAddress').value.trim();
    const durationHours = parseInt(document.getElementById('visitDurationHours').value, 10) || 0;
    const durationMinutes = parseInt(document.getElementById('visitDurationMinutes').value, 10) || 0;
    const duration = durationHours * 60 + durationMinutes;
    const notes = document.getElementById('placeNotes').value.trim();
    const tags = collectSelectedTags();

    if (!name) {
        showAlert('type a place name first.', 'error');
        return;
    }

    if (!address) {
        if (!backendAvailable) {
            showAlert('maps not loaded yet. refresh the page and try again.', 'error');
            return;
        }

        try {
            const geocoded = await geocodePlaceName(name);
            address = geocoded.formatted_address || name;
            document.getElementById('placeAddress').value = address;

            if (geocoded.geometry && geocoded.geometry.location) {
                lastPlaceCoords = {
                    lat: geocoded.geometry.location.lat(),
                    lng: geocoded.geometry.location.lng()
                };
            }
        } catch (error) {
            showAlert('could not resolve that place. try a more specific name or pick a suggestion.', 'error');
            return;
        }
    }

    places.push({
        id: Date.now(),
        name,
        address,
        duration,
        notes,
        tags,
        coords: lastPlaceCoords
    });

    document.getElementById('placeName').value = '';
    document.getElementById('placeAddress').value = '';
    document.getElementById('visitDurationHours').value = '';
    document.getElementById('visitDurationMinutes').value = '';
    document.getElementById('placeNotes').value = '';
    document.getElementById('placeCustomTag').value = '';
    document.querySelectorAll('#placeTagOptions .tag-toggle.active').forEach(btn => btn.classList.remove('active'));
    lastPlaceCoords = null;

    updatePlacesList();
    updateFriendMeetOptions();
    renderItineraryDestChips();
    showAlert(`added ${name}`, 'success');
}

function removePlace(id) {
    places = places.filter(place => place.id !== id);
    updatePlacesList();
    updateFriendMeetOptions();
}

function formatDuration(minutes) {
    const total = Math.max(0, parseInt(minutes, 10) || 0);
    const hours = Math.floor(total / 60);
    const mins = total % 60;

    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
}

function renderTagBadges(tags) {
    if (!tags || tags.length === 0) return '';
    return `<div class="tag-badges">${tags.map(tag => `<span class="tag-badge">${tag}</span>`).join('')}</div>`;
}

function updatePlacesList() {
    const list = document.getElementById('placesList');

    if (places.length === 0) {
        list.innerHTML = '<p class="empty-state">no places added yet</p>';
        renderItineraryDestChips();
        scheduleTripSave();
        return;
    }

    list.innerHTML = places.map(place => `
        <div class="place-item">
            <div class="item-content">
                <strong>${place.name}</strong>
                <small>${place.address}</small>
                <small>${place.duration > 0 ? `visit ${formatDuration(place.duration)}` : 'pass-through (no duration set)'}</small>
                ${place.notes ? `<small class="place-notes">» ${place.notes}</small>` : ''}
                ${renderTagBadges(place.tags)}
            </div>
            <button class="btn-remove" onclick="removePlace(${place.id})">remove</button>
        </div>
    `).join('');

    renderItineraryDestChips();
    scheduleTripSave();
}

function updateFriendMeetOptions() {
    const select = document.getElementById('friendMeetLocation');
    if (!select) return;

    if (places.length === 0) {
        select.innerHTML = '<option value="">add a place first</option>';
        select.disabled = true;
        return;
    }

    select.disabled = false;
    select.innerHTML = `
        <option value="">choose place</option>
        ${places.map(place => `<option value="${place.name}">${place.name}</option>`).join('')}
    `;
}

function addFriend() {
    const name = document.getElementById('friendName').value.trim();
    const arrivalTime = document.getElementById('friendArrivalTime').value;
    const meetLocation = document.getElementById('friendMeetLocation').value;

    if (!name || !arrivalTime || !meetLocation) {
        showAlert('please fill in the friend name, arrival time, and meeting place.', 'error');
        return;
    }

    friends.push({
        id: Date.now(),
        name,
        arrivalTime,
        meetLocation
    });

    document.getElementById('friendName').value = '';
    document.getElementById('friendArrivalTime').value = '09:00';
    document.getElementById('friendMeetLocation').value = '';

    updateFriendsList();
    showAlert(`saved friend ${name}`, 'success');
}

function removeFriend(id) {
    friends = friends.filter(friend => friend.id !== id);
    updateFriendsList();
}

function updateFriendsList() {
    const list = document.getElementById('friendsList');

    if (friends.length === 0) {
        list.innerHTML = '<p class="empty-state">no friends added yet</p>';
        scheduleTripSave();
        return;
    }

    list.innerHTML = friends.map(friend => `
        <div class="friend-chip">
            <button class="friend-remove" onclick="removeFriend(${friend.id})" aria-label="Remove ${friend.name}">✕</button>
            <div class="friend-avatar">${friend.name.charAt(0).toUpperCase()}</div>
            <div class="friend-name">${friend.name}</div>
            <div class="friend-meta">${friend.arrivalTime}</div>
            <div class="friend-meta">${friend.meetLocation}</div>
        </div>
    `).join('');
    scheduleTripSave();
}

async function resolveStartingPointCoords(startingPoint) {
    if (startingPointCoords) return startingPointCoords;
    if (!backendAvailable) return null;

    try {
        const geocoded = await geocodePlaceName(startingPoint);
        if (geocoded.geometry && geocoded.geometry.location) {
            startingPointCoords = {
                lat: geocoded.geometry.location.lat(),
                lng: geocoded.geometry.location.lng()
            };
            return startingPointCoords;
        }
    } catch (error) {
        // Backend will fall back to geocoding the address itself.
    }
    return null;
}

// PLAN SHAPE (skeleton): an ordered sequence of category slots (e.g. Activity,
// Food, Activity) that places get assigned into by nearest-match, so the trip
// follows a deliberate shape instead of just add-order.
function addSkeletonSlot(tag) {
    skeleton.push(tag);
    renderSkeleton();
}

function removeSkeletonSlot(index) {
    skeleton.splice(index, 1);
    renderSkeleton();
}

function clearSkeleton() {
    skeleton = [];
    renderSkeleton();
}

function skeletonSlotLabel(tag) {
    return tag === 'Any' ? 'any' : tag.toLowerCase();
}

function renderSkeleton() {
    const box = document.getElementById('skeletonSequence');
    if (!box) return;

    if (skeleton.length === 0) {
        box.innerHTML = '<p class="empty-state">no shape set - tap a category above to start building one</p>';
        scheduleTripSave();
        return;
    }

    box.innerHTML = skeleton.map((tag, index) => `
        <span class="skeleton-slot">${index + 1}. ${skeletonSlotLabel(tag)}<button type="button" class="skeleton-remove" onclick="removeSkeletonSlot(${index})">✕</button></span>${index < skeleton.length - 1 ? '<span class="skeleton-arrow">→</span>' : ''}
    `).join('');
    scheduleTripSave();
}

function haversineKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return Infinity;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Walk the skeleton once per day, each slot claiming whichever remaining
// eligible (by tag) place is geographically nearest to wherever we are so
// far - a greedy heuristic that keeps commute short without needing a full
// TSP solve. Leftover places that don't fit any slot are reported, not lost.
function assignPlacesToSkeleton(skeletonTags, allPlaces, startCoords, tripDays) {
    const remaining = [...allPlaces];
    const dayGroups = [];
    let currentCoords = startCoords || null;

    for (let day = 0; day < tripDays; day++) {
        const dayPlaces = [];
        for (const slotTag of skeletonTags) {
            const candidates = remaining.filter(p => slotTag === 'Any' || (p.tags || []).includes(slotTag));
            if (candidates.length === 0) continue;

            if (currentCoords) {
                candidates.sort((a, b) => haversineKm(currentCoords, a.coords) - haversineKm(currentCoords, b.coords));
            }

            const chosen = candidates[0];
            dayPlaces.push(chosen);
            remaining.splice(remaining.indexOf(chosen), 1);
            if (chosen.coords) currentCoords = chosen.coords;
        }
        dayGroups.push(dayPlaces);
    }

    if (remaining.length > 0) {
        showAlert(`${remaining.length} place(s) didn't match your plan shape and weren't scheduled: ${remaining.map(p => p.name).join(', ')}`, 'info');
    }

    return dayGroups;
}

function splitPlacesEvenlyByDay(allPlaces, tripDays) {
    const perDay = Math.floor(allPlaces.length / tripDays);
    const remainder = allPlaces.length % tripDays;
    const groups = [];
    let idx = 0;
    for (let d = 0; d < tripDays; d++) {
        const count = perDay + (d < remainder ? 1 : 0);
        groups.push(allPlaces.slice(idx, idx + count));
        idx += count;
    }
    return groups;
}

function toMinutes(timeStr) {
    const [h, m] = (timeStr || '00:00').split(':').map(Number);
    return h * 60 + m;
}

function getDayStartTime(day) {
    return dayStartTimes[day] || document.getElementById('startTime').value || '09:00';
}

function renderDayStartTimeInputs() {
    const days = parseInt(document.getElementById('tripDays').value, 10) || 1;
    const container = document.getElementById('dayStartTimesContainer');
    if (!container) return;

    if (days <= 1) {
        container.innerHTML = '';
        return;
    }

    const defaultTime = document.getElementById('startTime').value || '09:00';
    for (let d = 2; d <= days; d++) {
        if (!dayStartTimes[d]) dayStartTimes[d] = defaultTime;
    }

    container.innerHTML = Array.from({ length: days - 1 }, (_, i) => i + 2).map(d => `
        <div class="day-start-row">
            <label>day ${d} start</label>
            <input type="time" value="${dayStartTimes[d]}" onchange="dayStartTimes[${d}] = this.value">
        </div>
    `).join('');
}

async function generateItinerary() {
    if (places.length === 0) {
        showAlert('add at least one place first.', 'error');
        return;
    }

    const startingPoint = document.getElementById('startingPoint').value.trim();
    const travelMode = document.getElementById('travelMode').value;
    const tripDays = parseInt(document.getElementById('tripDays').value, 10) || 1;

    if (!startingPoint) {
        showAlert('set a starting point.', 'error');
        return;
    }

    for (let d = 1; d <= tripDays; d++) {
        dayStartTimes[d] = getDayStartTime(d);
    }

    const startCoords = await resolveStartingPointCoords(startingPoint);

    const dayGroups = skeleton.length > 0
        ? assignPlacesToSkeleton(skeleton, places, startCoords, tripDays)
        : splitPlacesEvenlyByDay(places, tripDays);

    try {
        currentDayView = 1;
        itinerary = await buildMultiDayItinerary(startingPoint, startCoords, dayGroups, travelMode);
        displayItinerary(itinerary);
        switchTab('itinerary');
        showAlert('itinerary ready! edit as needed.', 'success');
    } catch (error) {
        showAlert(`could not generate itinerary: ${error.message}`, 'error');
    }
}

// Composes the itinerary day-by-day (always calling the backend with days=1
// per chunk) so each day can have its own start time and, when a plan shape
// is set, its own skeleton-assigned place order.
async function buildMultiDayItinerary(startingPoint, startCoords, dayGroups, travelMode) {
    const fullItinerary = [];
    let currentLocation = startingPoint;
    let currentCoords = startCoords;

    for (let i = 0; i < dayGroups.length; i++) {
        const dayPlaces = dayGroups[i];
        const dayNum = i + 1;
        if (dayPlaces.length === 0) continue;

        if (fullItinerary.length > 0) {
            fullItinerary.push({ type: 'day_break', day: dayNum, date: '---' });
        }

        const dayStart = getDayStartTime(dayNum);
        const dayItinerary = await optimizeRoute(currentLocation, currentCoords, dayPlaces, friends, dayStart, travelMode, 1);
        dayItinerary.forEach(item => { item.day = dayNum; });
        fullItinerary.push(...dayItinerary);

        const lastVisit = [...dayItinerary].reverse().find(item => item.type === 'visit');
        if (lastVisit) {
            currentLocation = lastVisit.place;
            currentCoords = lastVisit.coords;
        }
    }

    return fullItinerary;
}

async function optimizeRoute(start, startCoords, places, friends, startTime, travelMode, tripDays = 1) {
    try {
        const response = await fetch('/api/optimize-itinerary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startingPoint: start,
                startingPointCoords: startCoords,
                places: places,
                friends: friends,
                startTime: startTime,
                travelMode: travelMode,
                days: tripDays
            })
        });

        if (!response.ok) {
            throw new Error('Backend optimization failed');
        }

        const data = await response.json();
        return data.itinerary || [];
    } catch (error) {
        console.error('Optimization error:', error);
        // Fallback: simple ordered itinerary (no live distance data available)
        return createSimpleItinerary(start, startCoords, places, friends, startTime, tripDays);
    }
}

function createSimpleItinerary(start, startCoords, places, friends, startTime, tripDays = 1) {
    const [startHour, startMin] = startTime.split(':').map(Number);
    let currentTime = startHour * 60 + startMin;
    const itinerary = [];

    // Simple route: visit places in order
    let lastLocation = start;
    let lastCoords = startCoords || null;

    for (let dayIdx = 0; dayIdx < tripDays; dayIdx++) {
        if (dayIdx > 0) {
            currentTime = startHour * 60 + startMin; // Reset time each day
            lastLocation = start;
            lastCoords = startCoords || null;
            itinerary.push({
                type: 'day_break',
                day: dayIdx + 1,
                date: '---'
            });
        }

        for (let i = 0; i < places.length; i++) {
            const place = places[i];
            const placeFriends = friends.filter(f => f.meetLocation === place.name);
            const duration = place.duration || 0;

            // Travel segment
            itinerary.push({
                type: 'travel',
                from: lastLocation,
                to: place.name,
                fromCoords: lastCoords,
                toCoords: place.coords || null,
                duration: 20,
                distance: '---',
                accurate: false,
                startTime: formatTime(currentTime),
                endTime: formatTime(currentTime + 20),
                travelMode: 'driving',
                day: dayIdx + 1
            });
            currentTime += 20;

            // Visit segment
            const arrival = formatTime(currentTime);
            const depart = formatTime(currentTime + duration);

            itinerary.push({
                type: 'visit',
                place: place.name,
                address: place.address,
                coords: place.coords || null,
                notes: place.notes || '',
                tags: place.tags || [],
                duration: duration,
                startTime: arrival,
                endTime: depart,
                friends: placeFriends.map(f => f.name).join(', ') || 'Solo',
                day: dayIdx + 1,
                canEdit: true,
                canDelete: true
            });

            currentTime += duration;
            lastCoords = place.coords || null;
            lastLocation = place.name;
        }
    }

    return itinerary;
}

function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function modeLabel(mode) {
    return TRAVEL_MODE_LABELS[mode] || mode;
}

function changeDayView(delta) {
    currentDayView += delta;
    displayItinerary(itinerary);
}

function updateDayStartTime(value) {
    dayStartTimes[currentDayView] = value;
    normalizeItinerary();
    displayItinerary(itinerary);
}

function displayItinerary(itineraryItems) {
    const result = document.getElementById('itineraryResult');
    const pager = document.getElementById('dayPager');
    const pagerLabel = document.getElementById('dayPagerLabel');
    const pagerStartTime = document.getElementById('dayPagerStartTime');

    if (!itineraryItems || itineraryItems.length === 0) {
        result.innerHTML = '<p class="empty-state">your cute goat route will show up here. set your trip settings above and generate, or drag a place in.</p>';
        if (pager) pager.classList.add('hidden');
        scheduleTripSave();
        return;
    }

    const totalDays = itineraryItems.reduce((max, item) => item.day ? Math.max(max, item.day) : max, 1);
    if (currentDayView > totalDays) currentDayView = totalDays;
    if (currentDayView < 1) currentDayView = 1;

    if (pager) {
        if (totalDays > 1) {
            pager.classList.remove('hidden');
            pagerLabel.textContent = `day ${currentDayView} of ${totalDays}`;
            if (pagerStartTime) pagerStartTime.value = getDayStartTime(currentDayView);
        } else {
            pager.classList.add('hidden');
        }
    }

    const rows = itineraryItems.map((item, index) => {
        if (item.type === 'day_break') return '';
        if ((item.day || 1) !== currentDayView) return '';

        if (item.type === 'travel') {
            const distance = item.distance && item.distance !== '---' ? `${item.distance} · ` : '';
            const estimateNote = item.accurate === false ? ' <small class="est-note">(estimated)</small>' : '';
            return `
                <tr class="itinerary-row travel-row" data-index="${index}">
                    <td class="col-time">${item.startTime} → ${item.endTime}</td>
                    <td class="col-place">
                        ▸
                        <select class="mode-select" onchange="changeLegMode(${index}, this.value)">
                            ${TRAVEL_MODES.map(mode => `<option value="${mode}" ${item.travelMode === mode ? 'selected' : ''}>${modeLabel(mode)}</option>`).join('')}
                        </select>
                    </td>
                    <td class="col-address">${item.from} → ${item.to}<br><small>${distance}${formatDuration(item.duration)}${estimateNote}</small></td>
                    <td class="col-people">—</td>
                    <td class="col-actions"></td>
                </tr>
            `;
        }

        if (item.type === 'visit') {
            const timeCell = item.duration > 0
                ? `${item.startTime} - ${item.endTime}<br><small>stay ${formatDuration(item.duration)}</small>`
                : `${item.startTime}<br><small>pass-through</small>`;
            return `
                <tr class="itinerary-row visit-row" data-index="${index}">
                    <td class="col-time">${timeCell}</td>
                    <td class="col-place">⌖ ${item.place}${renderTagBadges(item.tags)}</td>
                    <td class="col-address">${item.address || '—'}${item.notes ? `<br><small class="itinerary-note">» ${item.notes}</small>` : ''}</td>
                    <td class="col-people">${item.friends || 'solo'}</td>
                    <td class="col-actions">
                        <button class="btn-small" onclick="editItineraryItem(${index})">✎</button>
                        <button class="btn-small" onclick="deleteItineraryItem(${index})">✕</button>
                    </td>
                </tr>
            `;
        }

        return `
            <tr class="itinerary-row" data-index="${index}">
                <td colspan="5">${JSON.stringify(item)}</td>
            </tr>
        `;
    }).join('');

    result.innerHTML = `
        <table class="itinerary-table">
            <thead>
                <tr>
                    <th>time</th>
                    <th>place</th>
                    <th>address</th>
                    <th>people</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    scheduleTripSave();
}

async function changeLegMode(index, mode) {
    const item = itinerary[index];
    if (!item || item.type !== 'travel') return;

    item.travelMode = mode;

    if (!backendAvailable || !item.fromCoords || !item.toCoords) {
        // No coords to query accurately with - keep existing duration, just relabel.
        displayItinerary(itinerary);
        return;
    }

    try {
        const response = await fetch('/api/travel-time', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                originCoords: item.fromCoords,
                destinationCoords: item.toCoords,
                mode
            })
        });

        if (!response.ok) throw new Error('Could not fetch travel time');

        const data = await response.json();
        item.duration = data.duration;
        item.distance = data.distance;
        item.accurate = data.accurate;
    } catch (error) {
        showAlert('could not refresh travel time for that mode.', 'error');
    }

    normalizeItinerary();
    displayItinerary(itinerary);
}

// Recomputes from/to labels, coords, day, and start/end times for every item, in order.
// Runs after any insert, delete, or duration edit so the itinerary stays consistent.
function normalizeItinerary() {
    const startingPoint = (document.getElementById('startingPoint').value || '').trim() || 'starting point';
    let day = 1;
    let current = toMinutes(getDayStartTime(1));
    let lastLocation = startingPoint;
    let lastCoords = startingPointCoords;

    itinerary.forEach((item, index) => {
        if (item.type === 'day_break') {
            // Only the clock resets each day - travel continues from wherever the
            // previous day's last visit left off, matching the backend's own logic.
            day = item.day;
            current = toMinutes(getDayStartTime(day));
            return;
        }

        if (item.type === 'travel') {
            item.day = day;
            item.from = lastLocation;
            item.fromCoords = lastCoords;
            const next = itinerary[index + 1];
            if (next && next.type === 'visit') {
                item.to = next.place;
                item.toCoords = next.coords || null;
            }
            item.startTime = formatTime(current);
            current += item.duration;
            item.endTime = formatTime(current);
            return;
        }

        if (item.type === 'visit') {
            item.day = day;
            item.startTime = formatTime(current);
            current += item.duration;
            item.endTime = formatTime(current);
            lastLocation = item.place;
            lastCoords = item.coords || null;
        }
    });
}

function parseDurationInput(input, fallback) {
    if (input == null) return null;
    const trimmed = input.trim().toLowerCase();
    if (trimmed === '') return null;

    if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10);
    }

    const hmMatch = trimmed.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/);
    if (hmMatch && (hmMatch[1] || hmMatch[2])) {
        return parseInt(hmMatch[1] || '0', 10) * 60 + parseInt(hmMatch[2] || '0', 10);
    }

    const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
    if (colonMatch) {
        return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
    }

    return fallback;
}

function editItineraryItem(index) {
    const item = itinerary[index];
    if (!item || item.type !== 'visit') return;

    const input = prompt(`edit visit duration for ${item.place} (e.g. "1h 30m", "45m", or "0" for pass-through):`, formatDuration(item.duration));
    if (input == null) return;

    const parsed = parseDurationInput(input, null);
    if (parsed == null || parsed < 0) {
        showAlert('could not read that duration. try formats like "1h 30m", "45m", or "0".', 'error');
        return;
    }

    item.duration = parsed;
    normalizeItinerary();
    displayItinerary(itinerary);
    showAlert(`updated ${item.place}`, 'success');
}

function deleteItineraryItem(index) {
    const item = itinerary[index];
    if (!item) return;
    if (!confirm('remove this item from itinerary?')) return;

    if (item.type === 'visit') {
        const prev = itinerary[index - 1];
        if (prev && prev.type === 'travel') {
            itinerary.splice(index - 1, 2);
        } else {
            itinerary.splice(index, 1);
        }
    } else {
        itinerary.splice(index, 1);
    }

    normalizeItinerary();
    displayItinerary(itinerary);
    showAlert('item removed', 'success');
}

// DRAG AND DROP: drag a place chip into the itinerary to insert a visit there
function renderItineraryDestChips() {
    const box = document.getElementById('itineraryDestChips');
    if (!box) return;

    if (places.length === 0) {
        box.innerHTML = '<p class="empty-state">add places in the places tab, then drag them in here.</p>';
        return;
    }

    box.innerHTML = places.map(place => `
        <div class="dest-chip" draggable="true" data-place-id="${place.id}" ondragstart="handleChipDragStart(event, ${place.id})">
            ⌖ ${place.name}
        </div>
    `).join('');
}

function handleChipDragStart(event, placeId) {
    event.dataTransfer.setData('text/plain', String(placeId));
    event.dataTransfer.effectAllowed = 'copy';
}

// Absolute [start, end) index range within `itinerary` for the day currently shown.
function getCurrentDayRange() {
    const breaks = [];
    itinerary.forEach((item, index) => {
        if (item.type === 'day_break') breaks.push({ index, day: item.day });
    });

    if (currentDayView <= 1) {
        return { start: 0, end: breaks.length > 0 ? breaks[0].index : itinerary.length };
    }

    const startBreak = breaks.find(b => b.day === currentDayView);
    if (!startBreak) return { start: 0, end: itinerary.length };

    const nextBreak = breaks.find(b => b.day === currentDayView + 1);
    return { start: startBreak.index + 1, end: nextBreak ? nextBreak.index : itinerary.length };
}

// Valid insertion points (absolute itinerary indices) within the visible day only.
function getItineraryBoundaries() {
    const { start, end } = getCurrentDayRange();
    const boundaries = [start];
    for (let index = start; index < end; index++) {
        if (itinerary[index].type === 'visit') boundaries.push(index + 1);
    }
    return boundaries;
}

function getNearestBoundary(clientY) {
    const rows = Array.from(document.querySelectorAll('#itineraryResult tr[data-index]'));
    if (rows.length === 0) return getCurrentDayRange().start;

    const rowByIndex = new Map(rows.map(row => [parseInt(row.dataset.index, 10), row]));
    const boundaries = getItineraryBoundaries();
    let nearest = boundaries[boundaries.length - 1];
    let smallestDistance = Infinity;

    boundaries.forEach(boundary => {
        const row = rowByIndex.get(boundary);
        const y = row
            ? row.getBoundingClientRect().top
            : rows[rows.length - 1].getBoundingClientRect().bottom;
        const distance = Math.abs(clientY - y);
        if (distance < smallestDistance) {
            smallestDistance = distance;
            nearest = boundary;
        }
    });

    return nearest;
}

function clearDropIndicator() {
    document.querySelectorAll('.drop-indicator-before, .drop-indicator-after').forEach(el => {
        el.classList.remove('drop-indicator-before', 'drop-indicator-after');
    });
}

function updateDropIndicator(clientY) {
    clearDropIndicator();
    const rows = document.querySelectorAll('#itineraryResult tr[data-index]');
    if (rows.length === 0) return;

    const boundary = getNearestBoundary(clientY);
    const targetRow = document.querySelector(`#itineraryResult tr[data-index="${boundary}"]`);
    if (targetRow) {
        targetRow.classList.add('drop-indicator-before');
    } else {
        rows[rows.length - 1].classList.add('drop-indicator-after');
    }
}

function handleItineraryDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    updateDropIndicator(event.clientY);
}

function handleItineraryDragLeave(event) {
    if (event.target === event.currentTarget) {
        clearDropIndicator();
    }
}

function handleItineraryDrop(event) {
    event.preventDefault();
    const placeId = parseInt(event.dataTransfer.getData('text/plain'), 10);
    const boundary = getNearestBoundary(event.clientY);
    clearDropIndicator();

    if (!placeId) return;
    insertDestinationAtBoundary(placeId, boundary);
}

async function insertDestinationAtBoundary(placeId, boundary) {
    const place = places.find(p => p.id === placeId);
    if (!place) return;

    const defaultTravelMode = document.getElementById('travelMode').value || 'driving';
    const placeFriends = friends.filter(f => f.meetLocation === place.name).map(f => f.name).join(', ') || 'Solo';

    const travelItem = { type: 'travel', from: '', to: place.name, duration: 20, distance: '---', accurate: false, travelMode: defaultTravelMode };
    const visitItem = {
        type: 'visit',
        place: place.name,
        address: place.address,
        coords: place.coords || null,
        notes: place.notes || '',
        tags: place.tags || [],
        duration: place.duration || 0,
        friends: placeFriends,
        canEdit: true,
        canDelete: true
    };

    itinerary.splice(boundary, 0, travelItem, visitItem);
    normalizeItinerary();
    displayItinerary(itinerary);
    showAlert(`added ${place.name} to itinerary`, 'success');

    // Refine the new leg's time/distance with a real Distance Matrix lookup, if possible.
    if (backendAvailable && travelItem.fromCoords && travelItem.toCoords) {
        try {
            const response = await fetch('/api/travel-time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    originCoords: travelItem.fromCoords,
                    destinationCoords: travelItem.toCoords,
                    mode: defaultTravelMode
                })
            });
            if (response.ok) {
                const data = await response.json();
                travelItem.duration = data.duration;
                travelItem.distance = data.distance;
                travelItem.accurate = data.accurate;
                normalizeItinerary();
                displayItinerary(itinerary);
            }
        } catch (error) {
            // Keep the placeholder estimate if this fails.
        }
    }
}

// SHARING: save the full trip state to the backend and hand back a link that
// loads the same state - any further edits (by you or whoever opens the
// link) save back to that same id, so it stays in sync on reload.
function collectTripState() {
    return {
        places,
        friends,
        itinerary,
        skeleton,
        dayStartTimes,
        startingPoint: document.getElementById('startingPoint').value,
        startingPointCoords,
        startTime: document.getElementById('startTime').value,
        tripDays: document.getElementById('tripDays').value,
        travelMode: document.getElementById('travelMode').value
    };
}

function scheduleTripSave() {
    if (!currentTripId) return;
    clearTimeout(tripSaveTimeout);
    tripSaveTimeout = setTimeout(saveTripState, 800);
}

async function saveTripState() {
    if (!currentTripId) return;
    try {
        await fetch(`/api/trip/${currentTripId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectTripState())
        });
    } catch (error) {
        console.error('could not save shared trip state:', error);
    }
}

async function shareItinerary() {
    try {
        const response = await fetch('/api/trip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectTripState())
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'save failed');
        }

        const data = await response.json();
        currentTripId = data.id;

        const url = new URL(window.location.href);
        url.search = `?trip=${currentTripId}`;
        const shareUrl = url.toString();
        window.history.replaceState({}, '', shareUrl);

        try {
            await navigator.clipboard.writeText(shareUrl);
            showAlert('share link copied to clipboard!', 'success');
        } catch (clipboardError) {
            prompt('copy this link to share:', shareUrl);
        }
    } catch (error) {
        showAlert(`could not create a share link: ${error.message}`, 'error');
    }
}

async function loadSharedTrip(id) {
    try {
        const response = await fetch(`/api/trip/${id}`);
        if (!response.ok) {
            showAlert('that shared trip link is invalid or expired.', 'error');
            return;
        }

        const state = await response.json();
        currentTripId = id;

        places = state.places || [];
        friends = state.friends || [];
        itinerary = state.itinerary || [];
        skeleton = state.skeleton || [];
        dayStartTimes = state.dayStartTimes || {};
        startingPointCoords = state.startingPointCoords || null;

        if (state.startingPoint) document.getElementById('startingPoint').value = state.startingPoint;
        if (state.startTime) document.getElementById('startTime').value = state.startTime;
        if (state.tripDays) document.getElementById('tripDays').value = state.tripDays;
        if (state.travelMode) document.getElementById('travelMode').value = state.travelMode;

        updatePlacesList();
        updateFriendsList();
        updateFriendMeetOptions();
        renderSkeleton();
        renderDayStartTimeInputs();
        displayItinerary(itinerary);
        showAlert('loaded shared trip - your edits save back to this link.', 'success');
    } catch (error) {
        showAlert('could not load that shared trip.', 'error');
    }
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = type;
    alertDiv.textContent = message;
    alertDiv.style.position = 'fixed';
    alertDiv.style.top = '20px';
    alertDiv.style.right = '20px';
    alertDiv.style.zIndex = '9999';
    alertDiv.style.minWidth = '280px';
    alertDiv.style.padding = '14px 18px';
    alertDiv.style.borderRadius = '18px';
    alertDiv.style.background = type === 'error' ? '#fde7e7' : type === 'success' ? '#e8f6eb' : '#fff3db';
    alertDiv.style.color = type === 'error' ? '#8a2d26' : type === 'success' ? '#2d6a4f' : '#7b5e57';
    alertDiv.style.boxShadow = '0 18px 34px rgba(83, 48, 44, 0.12)';

    document.body.appendChild(alertDiv);

    setTimeout(() => {
        alertDiv.remove();
    }, 3200);
}

// TAB FUNCTIONALITY
function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // Deactivate all buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show selected tab
    const selectedTab = document.getElementById(tabName + '-tab');
    if (selectedTab) {
        selectedTab.classList.add('active');
    }

    // Activate selected button
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

window.addEventListener('DOMContentLoaded', () => {
    updatePlacesList();
    updateFriendsList();
    updateFriendMeetOptions();
    renderSkeleton();
    renderDayStartTimeInputs();

    // Tab button listeners
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.getAttribute('data-tab'));
        });
    });

    const placeNameInput = document.getElementById('placeName');
    if (placeNameInput) {
        placeNameInput.addEventListener('input', (event) => {
            scheduleSuggestionSearch('place', event.target.value);
        });

        placeNameInput.addEventListener('blur', () => {
            setTimeout(() => clearSuggestions('place'), 200);
        });
    }

    const startingPointInput = document.getElementById('startingPoint');
    if (startingPointInput) {
        startingPointInput.addEventListener('input', (event) => {
            startingPointCoords = null;
            scheduleSuggestionSearch('startingPoint', event.target.value);
        });

        startingPointInput.addEventListener('blur', () => {
            setTimeout(() => clearSuggestions('startingPoint'), 200);
        });
    }

    checkBackendStatus();

    const params = new URLSearchParams(window.location.search);
    const tripId = params.get('trip');
    if (tripId) {
        loadSharedTrip(tripId);
    }
});
