@echo off
rem D2R drop calculator launcher: starts a local server and opens the browser. No game install needed (data.json ships with the repo).
cd /d "%~dp0"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  echo Python 3 was not found on PATH. Install it from https://www.python.org/ or serve this folder with any static web server.
  pause & exit /b 1
)
if not exist data.json (
  echo data.json not found. Get it from the repository, or build it: run "python tools/extract_tables.py" ^(needs D2R installed^) then "python build.py".
  pause & exit /b 1
)
start "D2R DropCalc server (close this window to stop)" /min %PY% -m http.server 8000 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8000/index.html
