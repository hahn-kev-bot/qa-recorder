@echo off
rem Opens the QA Recorder desktop app. Make a desktop shortcut to this file to start it from there.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, this only happens once...
  call npm install || (pause & exit /b 1)
)
rem "%~dp0." rather than "%~dp0": a trailing backslash would escape the closing quote
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
