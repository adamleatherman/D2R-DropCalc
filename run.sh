#!/bin/sh
# D2R drop calculator launcher: serves this folder and opens the page. No game install needed.
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python)
[ -n "$PY" ] || { echo "Python 3 was not found on PATH; serve this folder with any static web server instead." >&2; exit 1; }
[ -f data.json ] || { echo "data.json not found. Get it from the repository, or build it: python3 tools/extract_tables.py (needs D2R installed), then python3 build.py." >&2; exit 1; }
URL=http://127.0.0.1:8000/index.html
echo "Serving on $URL (Ctrl+C to stop)"
( sleep 1; xdg-open "$URL" 2>/dev/null || open "$URL" 2>/dev/null || true ) &
exec "$PY" -m http.server 8000 --bind 127.0.0.1
