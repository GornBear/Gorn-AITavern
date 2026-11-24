@echo off
rem Keep this file ASCII-only: cmd.exe misparses UTF-8 text in batch files.
cd /d "%~dp0"
title AI Tavern

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org/
  echo         or run: winget install OpenJS.NodeJS.LTS
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
