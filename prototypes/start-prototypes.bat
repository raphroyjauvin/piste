@echo off
rem Serves the prototypes at http://localhost:8765 (close this window to stop)
start "" http://localhost:8765/
"%~dp0..\.venv\Scripts\python.exe" "%~dp0..\tools\serve.py" 8765 "%~dp0."

