@echo off
rem D2R drop calculator launcher: builds data.json if missing, starts the local server, opens the browser.
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul || set "PY=C:\Users\thein\AppData\Local\Programs\Python\Python314\python.exe"
if not exist data.json (
  echo data.json not found - building from C:\Users\thein\D2R-excel ...
  "%PY%" build.py || (echo build failed & pause & exit /b 1)
)
start "D2R DropCalc server (close this window to stop)" /min "%PY%" -m http.server 8000 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8000/index.html
