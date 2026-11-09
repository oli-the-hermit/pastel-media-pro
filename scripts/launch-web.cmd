@echo off
rem Pastel Media Pro, web version: starts the dev server and opens it in your browser.
rem If it is already running, it only opens the browser. Close this window to stop the server.
title Pastel Media Pro (web)
cd /d "%~dp0..\apps\player"
curl -s -o nul http://localhost:3300/ && (
  start "" http://localhost:3300/
  exit /b
)
echo Starting Pastel Media Pro (web) at http://localhost:3300/ ...
echo Close this window to stop it.
call npx vite --open
