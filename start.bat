@echo off
REM Usage: start.bat
setlocal

where node >nul 2>&1
if errorlevel 1 (
    echo Error: Node.js is not installed or not in PATH.
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
echo Using Node.js %NODE_VERSION%

if not exist "node_modules\" goto install
if not exist "server\node_modules\" goto install
if not exist "client\node_modules\" goto install
goto rundev

:install
echo Installing dependencies...
call npm run install:all
if errorlevel 1 (
    echo Error: Dependency installation failed.
    exit /b 1
)

:rundev
REM Kill stale processes on server (3001) and client (5173) ports so restarts work cleanly
for %%P in (3001 5173) do (
    for /f "tokens=5" %%i in ('netstat -ano ^| findstr ":%%P.*LISTENING" 2^>nul') do (
        echo Killing stale process on port %%P, PID %%i
        taskkill /F /T /PID %%i >nul 2>&1
    )
)

echo Starting August dev server...
call npm run dev
