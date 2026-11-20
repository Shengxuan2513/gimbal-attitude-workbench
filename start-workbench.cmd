@echo off
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo Build missing. Run npm ci and npm run build first.
  pause
  exit /b 1
)
python --version >nul 2>&1
if errorlevel 1 (
  echo Python is required to serve this local demo.
  pause
  exit /b 1
)
echo Local demo: http://127.0.0.1:4180/
echo No serial ports or motors are opened by this launcher.
start "" "http://127.0.0.1:4180/"
python -m http.server 4180 --bind 127.0.0.1 --directory dist
pause
