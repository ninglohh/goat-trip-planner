# GOAT (goin on a trip)

A web app for planning trips with friends: add destinations, tag and note them, bring friends in with arrival times, and generate a day-by-day itinerary with real Google Maps travel times - editable and drag-and-droppable after the fact.

## Features

- **Destinations**: name, address (autocomplete via Google Places), visit duration, notes, and tags (Home Court / Food / Activity / Self Care / custom)
- **Friends**: arrival time and meeting destination, shown as person-icon chips
- **Itinerary generation**: real Distance Matrix travel times per leg, multi-day trips with day-by-day pagination, per-leg travel mode switching, drag-and-drop to insert destinations, inline edit/delete

## Project layout

- `itinerary_index.html` / `itinerary_script.js` / `itinerary_style.css` - frontend (no build step, plain JS)
- `itinerary_backend.py` - Flask API (geocoding, place search, itinerary generation, per-leg travel time) and, for local dev only, serves the frontend files too
- `api/index.py` - Vercel serverless entrypoint; re-exports the same Flask `app`
- `vercel.json` - routes `/api/*` to the serverless function; everything else is served as static files

## Local development

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Set your API key
Copy the template and fill in your key:
```bash
cp .env.example .env
```
Edit `.env` and set `GOOGLE_MAPS_API_KEY` to a key with **Places API**, **Geocoding API**, and **Distance Matrix API** enabled (console.cloud.google.com/apis/credentials). `.env` is gitignored - never commit it.

### 3. Run
```bash
./start_backend.sh
```
This starts Flask on `http://localhost:5001`, which serves both the API (`/api/...`) and the frontend (`/`). Open `http://localhost:5001` in a browser - no separate static server needed.

## Deploying (GitHub + Vercel)

1. Push this repo to GitHub (don't commit `.env` - it's gitignored already).
2. Import the repo in [Vercel](https://vercel.com/new).
3. In the Vercel project's **Settings → Environment Variables**, add `GOOGLE_MAPS_API_KEY` with your real key. It is never read from a file in production - only from this dashboard setting.
4. Deploy. Vercel serves the static frontend files directly and runs `api/index.py` (the same Flask app) as a serverless function for anything under `/api/*`.
5. Every subsequent `git push` auto-deploys.

## API endpoints

All under `/api`:

- `POST /geocode` - `{ "address": "..." }` → `{ lat, lng, formatted_address }`
- `POST /place-search` - `{ "query": "..." }` → `{ results: [{ name, address, lat, lng }] }`
- `POST /optimize-itinerary` - places/friends/starting point/travel mode/days → full itinerary with real per-leg distance/duration
- `POST /travel-time` - `{ originCoords, destinationCoords, mode }` → recompute one leg for a different travel mode
- `GET /health` - `{ status, apiKeyConfigured }`

## Notes

- Route ordering across a day is the order you added destinations in (or drag-reordered), not automatically optimized (no TSP solve) - multi-day itineraries split destinations evenly across days and travel continues from wherever the previous day left off, rather than resetting to the starting point.
- If `GOOGLE_MAPS_API_KEY` isn't set, the app still runs but falls back to rough estimates (20 min per leg) and place search/geocoding won't return results - the status chip in the header reflects this.
