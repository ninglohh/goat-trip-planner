let places = [];
let friends = [];
let itinerary = [];
let lastPlaceCoords = null;
let startingPointCoords = null;
let backendAvailable = false;
let currentDayView = 1;
const suggestionSearchTimeouts = {};

const TRAVEL_MODES = ['driving', 'transit', 'walking', 'bicycling'];
const TRAVEL_MODE_LABELS = { driving: 'Driving', transit: 'Transit', walking: 'Walking', bicycling: 'Cycling' };

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
            updateApiStatus(false, 'Backend unreachable. Start itinerary_backend.py on port 5001.');
            return;
        }

        const data = await response.json();
        backendAvailable = true;

        if (data.apiKeyConfigured) {
            updateApiStatus(true, 'Backend connected ✅ Google Maps API key detected.');
        } else {
            updateApiStatus(true, 'Backend connected, but no Google Maps API key is set (GOOGLE_MAPS_API_KEY). Place search/geocoding will fail.', true);
        }
    } catch (error) {
        backendAvailable = false;
        updateApiStatus(false, 'Backend unreachable. Start itinerary_backend.py on port 5001.');
    }
}

function updateApiStatus(loaded, message, warn = false) {
    const status = document.getElementById('apiStatus');
    if (!status) return;

    if (loaded) {
        status.textContent = message || 'Backend connected ✅';
        status.classList.toggle('status-warn', warn);
        status.classList.toggle('status-ok', !warn);
        status.classList.remove('status-error');
    } else {
        status.textContent = message || 'Backend unavailable. Check the server and network.';
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
        box.innerHTML = '<div class="suggestion-item"><span class="suggestion-label">No results found</span></div>';
        box.classList.remove('hidden');
        config.latest = [];
        return;
    }

    config.latest = results;
    box.innerHTML = results.map((place, index) => `
        <button type="button" class="suggestion-item" onclick="selectSuggestionFor('${target}', ${index})">
            <span class="suggestion-label">${place.name}</span>
            <span class="suggestion-subtitle">${place.address || 'Address unavailable'}</span>
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
    const duration = (durationHours * 60 + durationMinutes) || 60;
    const notes = document.getElementById('placeNotes').value.trim();
    const tags = collectSelectedTags();

    if (!name) {
        showAlert('Type a destination name first.', 'error');
        return;
    }

    if (!address) {
        if (!backendAvailable) {
            showAlert('Maps not loaded yet. Refresh the page and try again.', 'error');
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
            showAlert('Could not resolve that place. Try a more specific name or pick a suggestion.', 'error');
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
    document.getElementById('visitDurationHours').value = '1';
    document.getElementById('visitDurationMinutes').value = '0';
    document.getElementById('placeNotes').value = '';
    document.getElementById('placeCustomTag').value = '';
    document.querySelectorAll('#placeTagOptions .tag-toggle.active').forEach(btn => btn.classList.remove('active'));
    lastPlaceCoords = null;

    updatePlacesList();
    updateFriendMeetOptions();
    renderItineraryDestChips();
    showAlert(`Added ${name}`, 'success');
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
        list.innerHTML = '<p class="empty-state">No destinations added yet</p>';
        renderItineraryDestChips();
        return;
    }

    list.innerHTML = places.map(place => `
        <div class="place-item">
            <div class="item-content">
                <strong>${place.name}</strong>
                <small>${place.address}</small>
                <small>Visit ${formatDuration(place.duration)}</small>
                ${place.notes ? `<small class="place-notes">📝 ${place.notes}</small>` : ''}
                ${renderTagBadges(place.tags)}
            </div>
            <button class="btn-remove" onclick="removePlace(${place.id})">Remove</button>
        </div>
    `).join('');

    renderItineraryDestChips();
}

function updateFriendMeetOptions() {
    const select = document.getElementById('friendMeetLocation');
    if (!select) return;

    if (places.length === 0) {
        select.innerHTML = '<option value="">Add a destination first</option>';
        select.disabled = true;
        return;
    }

    select.disabled = false;
    select.innerHTML = `
        <option value="">Choose destination</option>
        ${places.map(place => `<option value="${place.name}">${place.name}</option>`).join('')}
    `;
}

function addFriend() {
    const name = document.getElementById('friendName').value.trim();
    const arrivalTime = document.getElementById('friendArrivalTime').value;
    const meetLocation = document.getElementById('friendMeetLocation').value;

    if (!name || !arrivalTime || !meetLocation) {
        showAlert('Please fill in the friend name, arrival time, and meeting destination.', 'error');
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
    showAlert(`Saved friend ${name}`, 'success');
}

function removeFriend(id) {
    friends = friends.filter(friend => friend.id !== id);
    updateFriendsList();
}

function updateFriendsList() {
    const list = document.getElementById('friendsList');

    if (friends.length === 0) {
        list.innerHTML = '<p class="empty-state">No friends added yet</p>';
        return;
    }

    list.innerHTML = friends.map(friend => `
        <div class="friend-chip">
            <button class="friend-remove" onclick="removeFriend(${friend.id})" aria-label="Remove ${friend.name}">✕</button>
            <div class="friend-avatar">🧑</div>
            <div class="friend-name">${friend.name}</div>
            <div class="friend-meta">${friend.arrivalTime}</div>
            <div class="friend-meta">${friend.meetLocation}</div>
        </div>
    `).join('');
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

async function generateItinerary() {
    if (places.length === 0) {
        showAlert('Add at least one destination first.', 'error');
        return;
    }

    const startingPoint = document.getElementById('startingPoint').value.trim();
    const startTime = document.getElementById('startTime').value;
    const travelMode = document.getElementById('travelMode').value;
    const tripDays = parseInt(document.getElementById('tripDays').value, 10) || 1;

    if (!startingPoint || !startTime) {
        showAlert('Set a starting point and start time.', 'error');
        return;
    }

    const startCoords = await resolveStartingPointCoords(startingPoint);

    try {
        currentDayView = 1;
        itinerary = await optimizeRoute(startingPoint, startCoords, places, friends, startTime, travelMode, tripDays);
        backfillTravelDays(itinerary);
        displayItinerary(itinerary);
        switchTab('itinerary');
        showAlert('Itinerary ready! Edit as needed.', 'success');
    } catch (error) {
        showAlert(`Could not generate itinerary: ${error.message}`, 'error');
    }
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
            const depart = formatTime(currentTime + place.duration);

            itinerary.push({
                type: 'visit',
                place: place.name,
                address: place.address,
                coords: place.coords || null,
                notes: place.notes || '',
                tags: place.tags || [],
                duration: place.duration,
                startTime: arrival,
                endTime: depart,
                friends: placeFriends.map(f => f.name).join(', ') || 'Solo',
                day: dayIdx + 1,
                canEdit: true,
                canDelete: true
            });

            currentTime += place.duration;
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

function displayItinerary(itineraryItems) {
    const result = document.getElementById('itineraryResult');
    const pager = document.getElementById('dayPager');
    const pagerLabel = document.getElementById('dayPagerLabel');

    if (!itineraryItems || itineraryItems.length === 0) {
        result.innerHTML = '<p class="empty-state">Your cute goat route will show up here. Set your trip settings above and generate, or drag a destination in.</p>';
        if (pager) pager.classList.add('hidden');
        return;
    }

    const totalDays = itineraryItems.reduce((max, item) => item.day ? Math.max(max, item.day) : max, 1);
    if (currentDayView > totalDays) currentDayView = totalDays;
    if (currentDayView < 1) currentDayView = 1;

    if (pager) {
        if (totalDays > 1) {
            pager.classList.remove('hidden');
            pagerLabel.textContent = `Day ${currentDayView} of ${totalDays}`;
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
                        🚗
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
            return `
                <tr class="itinerary-row visit-row" data-index="${index}">
                    <td class="col-time">${item.startTime} - ${item.endTime}<br><small>Stay ${formatDuration(item.duration)}</small></td>
                    <td class="col-place">📍 ${item.place}${renderTagBadges(item.tags)}</td>
                    <td class="col-address">${item.address || '—'}${item.notes ? `<br><small class="itinerary-note">📝 ${item.notes}</small>` : ''}</td>
                    <td class="col-people">${item.friends || 'Solo'}</td>
                    <td class="col-actions">
                        <button class="btn-small" onclick="editItineraryItem(${index})">✏️</button>
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
                    <th>Time</th>
                    <th>Place</th>
                    <th>Address</th>
                    <th>People</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
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
        showAlert('Could not refresh travel time for that mode.', 'error');
    }

    normalizeItinerary();
    displayItinerary(itinerary);
}

// Backend visit/day_break items carry a `day`, but travel items don't - tag them
// from the surrounding day_break markers so day-view pagination can filter on it,
// without touching the backend's real from/to/duration/distance data.
function backfillTravelDays(items) {
    let day = 1;
    items.forEach(item => {
        if (item.type === 'day_break') {
            day = item.day;
            return;
        }
        if (item.type === 'travel') {
            item.day = day;
        }
    });
}

// Recomputes from/to labels, coords, day, and start/end times for every item, in order.
// Runs after any insert, delete, or duration edit so the itinerary stays consistent.
function normalizeItinerary() {
    const startingPoint = (document.getElementById('startingPoint').value || '').trim() || 'Starting point';
    const startTime = document.getElementById('startTime').value || '09:00';
    const [startHour, startMin] = startTime.split(':').map(Number);
    let current = startHour * 60 + startMin;
    let lastLocation = startingPoint;
    let lastCoords = startingPointCoords;
    let day = 1;

    itinerary.forEach((item, index) => {
        if (item.type === 'day_break') {
            // Only the clock resets each day - travel continues from wherever the
            // previous day's last visit left off, matching the backend's own logic.
            day = item.day;
            current = startHour * 60 + startMin;
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

    const input = prompt(`Edit visit duration for ${item.place} (e.g. "1h 30m" or "45m"):`, formatDuration(item.duration));
    if (input == null) return;

    const parsed = parseDurationInput(input, null);
    if (!parsed || parsed <= 0) {
        showAlert('Could not read that duration. Try formats like "1h 30m" or "45m".', 'error');
        return;
    }

    item.duration = parsed;
    normalizeItinerary();
    displayItinerary(itinerary);
    showAlert(`Updated ${item.place}`, 'success');
}

function deleteItineraryItem(index) {
    const item = itinerary[index];
    if (!item) return;
    if (!confirm('Remove this item from itinerary?')) return;

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
    showAlert('Item removed', 'success');
}

// DRAG AND DROP: drag a destination chip into the itinerary to insert a visit there
function renderItineraryDestChips() {
    const box = document.getElementById('itineraryDestChips');
    if (!box) return;

    if (places.length === 0) {
        box.innerHTML = '<p class="empty-state">Add destinations in the Destinations tab, then drag them in here.</p>';
        return;
    }

    box.innerHTML = places.map(place => `
        <div class="dest-chip" draggable="true" data-place-id="${place.id}" ondragstart="handleChipDragStart(event, ${place.id})">
            📍 ${place.name}
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
        duration: place.duration,
        friends: placeFriends,
        canEdit: true,
        canDelete: true
    };

    itinerary.splice(boundary, 0, travelItem, visitItem);
    normalizeItinerary();
    displayItinerary(itinerary);
    showAlert(`Added ${place.name} to itinerary`, 'success');

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
});
