@echo off
rem Keep this file ASCII-only: cmd.exe misparses UTF-8 text in batch files.
cd /d "%~dp0"
title AI Tavern

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22+ from https://nodejs.org/
  echo         or run: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

rem Node.js 22+ is required (same as "engines" in package.json).
node -e "process.exit(+process.versions.node.split('.')[0] < 22 ? 1 : 0)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo [ERROR] Node.js %%v is too old. AI Tavern needs Node.js 22 or newer.
  echo         Install the LTS version from https://nodejs.org/
  echo         or run: winget upgrade OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\sdk\" (
  echo First run: installing packages...
  call npm install --no-fund --no-audit
)

rem Opens the app in its own window (Edge/Chrome app mode). Closing the window stops the server.
node launch.js
if errorlevel 1 pause
