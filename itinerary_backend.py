"""
Trip Itinerary Planner Backend
Handles route optimization, distance/time calculations, and itinerary generation
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests
import json
import uuid
from urllib.parse import parse_qs, urlencode
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
CORS(app)


class VercelPathFix:
    """
    vercel.json rewrites every /api/* request to /api/index, and since the
    destination doesn't reference the captured :path*, Vercel appends it as a
    `path` query param instead of keeping it in the URL (e.g. a request for
    /api/health arrives here as PATH_INFO=/api/index?path=health). Rebuild the
    real path from that query param before Flask's router sees it, so our
    normal @app.route('/api/health') etc. definitions keep working unchanged.
    Locally (no rewrite involved), this is a no-op.
    """
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        if environ.get('PATH_INFO') == '/api/index':
            params = parse_qs(environ.get('QUERY_STRING', ''))
            sub_path = params.pop('path', [None])[0]
            if sub_path:
                environ['PATH_INFO'] = '/api/' + sub_path
                environ['QUERY_STRING'] = urlencode(params, doseq=True)
        return self.wsgi_app(environ, start_response)


app.wsgi_app = VercelPathFix(app.wsgi_app)


# Explicit routes for each known frontend asset (no catch-all) - this never risks
# exposing .env, source code, or logs from this directory over HTTP.
@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'itinerary_index.html')


@app.route('/itinerary_index.html')
def serve_index_html():
    return send_from_directory(BASE_DIR, 'itinerary_index.html')


@app.route('/itinerary_script.js')
def serve_script():
    return send_from_directory(BASE_DIR, 'itinerary_script.js')


@app.route('/itinerary_style.css')
def serve_style():
    return send_from_directory(BASE_DIR, 'itinerary_style.css')


@app.route('/goat_banner.png')
def serve_banner():
    return send_from_directory(BASE_DIR, 'goat_banner.png')

# Google Maps API Key (set as environment variable)
GOOGLE_MAPS_API_KEY = os.getenv('GOOGLE_MAPS_API_KEY', 'YOUR_GOOGLE_MAPS_API_KEY')

class ItineraryPlanner:
    def __init__(self, api_key):
        self.api_key = api_key
        self.base_url = "https://maps.googleapis.com/maps/api"
    
    def geocode_address(self, address):
        """Convert address to coordinates using Google Maps Geocoding API"""
        try:
            url = f"{self.base_url}/geocode/json"
            params = {
                'address': address,
                'key': self.api_key
            }
            response = requests.get(url, params=params, timeout=10)
            data = response.json()
            
            if data['status'] == 'OK':
                location = data['results'][0]['geometry']['location']
                return {
                    'lat': location['lat'],
                    'lng': location['lng'],
                    'formatted_address': data['results'][0]['formatted_address']
                }
            else:
                return None
        except Exception as e:
            print(f"Geocoding error: {e}")
            return None
    
    def get_distance_matrix(self, origins, destinations, mode='driving'):
        """Get distance and time between multiple locations"""
        try:
            url = f"{self.base_url}/distancematrix/json"

            # Format origins and destinations
            origin_addresses = '|'.join([f"{o['lat']},{o['lng']}" for o in origins])
            dest_addresses = '|'.join([f"{d['lat']},{d['lng']}" for d in destinations])

            params = {
                'origins': origin_addresses,
                'destinations': dest_addresses,
                'mode': mode,
                'key': self.api_key
            }

            response = requests.get(url, params=params, timeout=10)
            data = response.json()

            if data['status'] == 'OK':
                matrix = []
                for row in data['rows']:
                    row_data = []
                    for element in row['elements']:
                        if element['status'] == 'OK':
                            row_data.append({
                                'distance': element['distance']['value'],  # in meters
                                'duration': element['duration']['value'],  # in seconds
                                'distance_text': element['distance']['text'],
                                'duration_text': element['duration']['text']
                            })
                        else:
                            row_data.append(None)
                    matrix.append(row_data)
                return matrix
            else:
                return None
        except Exception as e:
            print(f"Distance matrix error: {e}")
            return None

    def get_leg(self, origin_coords, dest_coords, mode='driving'):
        """Distance/duration for a single origin -> destination leg, with a safe fallback."""
        matrix = None
        if origin_coords and dest_coords:
            matrix = self.get_distance_matrix([origin_coords], [dest_coords], mode)

        if matrix and matrix[0] and matrix[0][0]:
            element = matrix[0][0]
            return {
                'duration_minutes': max(1, round(element['duration'] / 60)),
                'distance_text': element['distance_text'],
                'accurate': True
            }

        return {'duration_minutes': 20, 'distance_text': '---', 'accurate': False}

    def resolve_coords(self, address, coords=None):
        """Use provided coords if present, otherwise geocode the address."""
        if coords and coords.get('lat') is not None and coords.get('lng') is not None:
            return coords
        if not address:
            return None
        geocoded = self.geocode_address(address)
        return {'lat': geocoded['lat'], 'lng': geocoded['lng']} if geocoded else None

    def search_places(self, query):
        """Search for places by text query using Google Places Find Place."""
        try:
            url = f"{self.base_url}/place/findplacefromtext/json"
            params = {
                'input': query,
                'inputtype': 'textquery',
                'fields': 'name,formatted_address,geometry',
                'key': self.api_key
            }
            response = requests.get(url, params=params, timeout=10)
            data = response.json()

            print(f"Place search for '{query}': status={data.get('status')}, key={self.api_key[:20]}...")
            
            if data.get('status') == 'OK' and data.get('candidates'):
                results = []
                for candidate in data['candidates']:
                    geometry = candidate.get('geometry', {}).get('location', {})
                    results.append({
                        'name': candidate.get('name'),
                        'address': candidate.get('formatted_address'),
                        'lat': geometry.get('lat'),
                        'lng': geometry.get('lng')
                    })
                return results
            elif data.get('status') != 'OK':
                print(f"  Error: {data.get('error_message', 'Unknown error')}")
            return []
        except Exception as e:
            print(f"Place search error: {e}")
            return []
    

planner = ItineraryPlanner(GOOGLE_MAPS_API_KEY)


def _to_minutes(time_str):
    hours, minutes = map(int, (time_str or '00:00').split(':'))
    return hours * 60 + minutes


def compute_attendees(friends, day, time_str):
    """Friends whose (day, arrival time) has passed by this point in the trip - no location matching."""
    current_minutes = _to_minutes(time_str)
    attendees = []
    for friend in friends:
        friend_day = friend.get('day') or 1
        if friend_day < day or (friend_day == day and _to_minutes(friend.get('arrivalTime')) <= current_minutes):
            attendees.append(friend['name'])
    return attendees


@app.route('/api/geocode', methods=['POST'])
def geocode():
    """Geocode an address to coordinates"""
    data = request.json
    address = data.get('address')
    
    if not address:
        return jsonify({'error': 'Address required'}), 400
    
    result = planner.geocode_address(address)
    
    if result:
        return jsonify(result)
    else:
        return jsonify({'error': 'Geocoding failed'}), 400


@app.route('/api/place-search', methods=['POST'])
def place_search():
    """Search for places by text query"""
    data = request.json
    query = data.get('query')

    if not query:
        return jsonify({'error': 'Query required'}), 400

    results = planner.search_places(query)
    return jsonify({'results': results})


@app.route('/api/optimize-itinerary', methods=['POST'])
def optimize_itinerary():
    """Generate optimized itinerary based on distance and timing"""
    data = request.json

    required_fields = ['startingPoint', 'places', 'startTime', 'travelMode']
    if not all(field in data for field in required_fields):
        return jsonify({'error': 'Missing required fields'}), 400

    try:
        places = data['places']
        friends = data.get('friends', [])
        start_time = data['startTime']
        travel_mode = data.get('travelMode', 'driving')
        num_days = data.get('days', 1)

        if not places:
            return jsonify({'error': 'No places provided'}), 400

        itinerary = []
        start_hour, start_min = map(int, start_time.split(':'))
        current_minutes = start_hour * 60 + start_min
        current_location = data['startingPoint']
        current_coords = planner.resolve_coords(data['startingPoint'], data.get('startingPointCoords'))

        places_per_day = len(places) // num_days
        remainder = len(places) % num_days

        for day_idx in range(num_days):
            if day_idx > 0:
                itinerary.append({
                    'type': 'day_break',
                    'day': day_idx + 1,
                    'date': '---'
                })
                current_minutes = start_hour * 60 + start_min  # Reset time

            # Determine places for this day
            start_idx = day_idx * places_per_day + min(day_idx, remainder)
            end_idx = start_idx + places_per_day + (1 if day_idx < remainder else 0)
            day_places = places[start_idx:end_idx]

            for place_idx, place in enumerate(day_places):
                place_coords = planner.resolve_coords(place.get('address'), place.get('coords'))

                # Travel segment - real distance/duration from Google, per-leg mode if provided
                leg_mode = place.get('travelMode') or travel_mode
                leg = planner.get_leg(current_coords, place_coords, leg_mode)
                travel_time = leg['duration_minutes']

                itinerary.append({
                    'type': 'travel',
                    'from': current_location,
                    'to': place['name'],
                    'fromCoords': current_coords,
                    'toCoords': place_coords,
                    'duration': travel_time,
                    'distance': leg['distance_text'],
                    'accurate': leg['accurate'],
                    'startTime': f"{current_minutes // 60:02d}:{current_minutes % 60:02d}",
                    'endTime': f"{(current_minutes + travel_time) // 60:02d}:{(current_minutes + travel_time) % 60:02d}",
                    'travelMode': leg_mode
                })
                current_minutes += travel_time

                # Visit segment
                duration = place.get('duration', 60)
                visit_start_time = f"{current_minutes // 60:02d}:{current_minutes % 60:02d}"
                visit_end_time = f"{(current_minutes + duration) // 60:02d}:{(current_minutes + duration) % 60:02d}"

                place_friends = compute_attendees(friends, day_idx + 1, visit_start_time)

                itinerary.append({
                    'type': 'visit',
                    'place': place['name'],
                    'address': place.get('address', 'Address unknown'),
                    'coords': place_coords,
                    'notes': place.get('notes', ''),
                    'tags': place.get('tags', []),
                    'duration': duration,
                    'startTime': visit_start_time,
                    'endTime': visit_end_time,
                    'friends': ', '.join(place_friends) if place_friends else 'Solo',
                    'day': day_idx + 1,
                    'canEdit': True,
                    'canDelete': True
                })

                current_minutes += duration
                current_location = place['name']
                current_coords = place_coords

        return jsonify({
            'itinerary': itinerary,
            'summary': {
                'total_duration_minutes': current_minutes - (start_hour * 60 + start_min),
                'optimized_order': list(range(len(places)))
            }
        })

    except Exception as e:
        print(f"Itinerary error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/travel-time', methods=['POST'])
def travel_time():
    """Recompute distance/duration for a single leg, e.g. when the user changes travel mode on one itinerary row."""
    data = request.json or {}
    mode = data.get('mode', 'driving')

    origin_coords = planner.resolve_coords(data.get('originAddress'), data.get('originCoords'))
    dest_coords = planner.resolve_coords(data.get('destinationAddress'), data.get('destinationCoords'))

    if not origin_coords or not dest_coords:
        return jsonify({'error': 'Could not resolve origin/destination'}), 400

    leg = planner.get_leg(origin_coords, dest_coords, mode)
    return jsonify({
        'duration': leg['duration_minutes'],
        'distance': leg['distance_text'],
        'accurate': leg['accurate'],
        'originCoords': origin_coords,
        'destinationCoords': dest_coords
    })


# Shared itineraries: state is stored in a Redis-compatible KV store (Vercel
# KV / Upstash) so a link can be opened by anyone and edits save back to the
# same id. Different storage integrations inject different env var names, so
# check both conventions rather than assuming one.
KV_URL = os.getenv('KV_REST_API_URL') or os.getenv('UPSTASH_REDIS_REST_URL')
KV_TOKEN = os.getenv('KV_REST_API_TOKEN') or os.getenv('UPSTASH_REDIS_REST_TOKEN')


def kv_configured():
    return bool(KV_URL and KV_TOKEN)


def kv_set(key, value_dict):
    response = requests.post(
        f"{KV_URL}/set/{key}",
        headers={'Authorization': f'Bearer {KV_TOKEN}'},
        data=json.dumps(value_dict),
        timeout=10
    )
    return response.status_code == 200


def kv_get(key):
    response = requests.get(
        f"{KV_URL}/get/{key}",
        headers={'Authorization': f'Bearer {KV_TOKEN}'},
        timeout=10
    )
    if response.status_code != 200:
        return None
    result = response.json().get('result')
    if result is None:
        return None
    return json.loads(result)


@app.route('/api/trip', methods=['POST'])
def create_trip():
    """Save a new shared trip, returning the id its link is built from."""
    if not kv_configured():
        return jsonify({'error': 'Sharing is not set up yet - connect a KV/Redis database in the Vercel dashboard.'}), 503

    trip_id = uuid.uuid4().hex[:10]
    state = request.json or {}

    try:
        if not kv_set(f'trip:{trip_id}', state):
            return jsonify({'error': 'Could not save trip'}), 502
    except Exception as e:
        print(f"Trip save error: {e}")
        return jsonify({'error': 'Could not save trip'}), 502

    return jsonify({'id': trip_id})


@app.route('/api/trip/<trip_id>', methods=['GET'])
def get_trip(trip_id):
    """Load a shared trip's full state by id."""
    if not kv_configured():
        return jsonify({'error': 'Sharing is not set up yet - connect a KV/Redis database in the Vercel dashboard.'}), 503

    try:
        state = kv_get(f'trip:{trip_id}')
    except Exception as e:
        print(f"Trip load error: {e}")
        return jsonify({'error': 'Could not load trip'}), 502

    if state is None:
        return jsonify({'error': 'Trip not found'}), 404

    return jsonify(state)


@app.route('/api/trip/<trip_id>', methods=['PUT'])
def update_trip(trip_id):
    """Overwrite a shared trip's state - used to autosave edits back to the link."""
    if not kv_configured():
        return jsonify({'error': 'Sharing is not set up yet - connect a KV/Redis database in the Vercel dashboard.'}), 503

    state = request.json or {}

    try:
        if not kv_set(f'trip:{trip_id}', state):
            return jsonify({'error': 'Could not save trip'}), 502
    except Exception as e:
        print(f"Trip update error: {e}")
        return jsonify({'error': 'Could not save trip'}), 502

    return jsonify({'ok': True})


@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    key_configured = bool(GOOGLE_MAPS_API_KEY) and GOOGLE_MAPS_API_KEY != 'YOUR_GOOGLE_MAPS_API_KEY'
    return jsonify({
        'status': 'ok',
        'message': 'Trip Itinerary Planner API is running',
        'apiKeyConfigured': key_configured,
        'sharingConfigured': kv_configured()
    })


if __name__ == '__main__':
    app.run(debug=False, port=5001)
