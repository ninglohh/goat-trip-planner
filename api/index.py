"""
Vercel serverless entrypoint. Re-exports the Flask app defined in
itinerary_backend.py at the project root, so there is a single source of
truth for the backend used both locally (via start_backend.sh) and on Vercel.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from itinerary_backend import app  # noqa: E402
