@echo off
title MITZPE METZODA - Launcher
echo ========================================================
echo   MITZPE METZODA Air Defense C2 Systems launcher
echo ========================================================
echo.

cd /d "%~dp0"

echo [1/3] Building the modern web UI frontend...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to build frontend UI. Ensure node and npm are installed.
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo [2/3] Preparing backend dependencies...
cd nodejs_backend
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install nodejs backend dependencies.
    pause
    exit /b %errorlevel%
)

echo.
echo [3/3] Starting MITZPE METZODA Single Server...
echo.
echo ========================================================
echo   The app is running! Starting Chrome in standalone mode...
echo   Url: http://localhost:8080
echo ========================================================
echo.

:: Launch Chrome in standalone App mode in the background after 2 seconds
start /b "" cmd /c "timeout /t 2 >nul && start chrome --app=http://localhost:8080"

node server.js
pause


