#!/bin/bash
# Starts the Trip Itinerary Planner backend, loading GOOGLE_MAPS_API_KEY from .env
cd "$(dirname "$0")"

if [ -f .env ]; then
    source .env
else
    echo "No .env found. Copy .env.example to .env and add your GOOGLE_MAPS_API_KEY."
fi

python itinerary_backend.py
