@echo off
title MCP GitHub Push - Status
cd /d "%~dp0"
if not exist "mcp-github-push-win-x64.exe" (
  echo ERROR: mcp-github-push-win-x64.exe tidak ditemukan di folder ini: %~dp0
  pause
  exit /b 1
)
mcp-github-push-win-x64.exe status
echo.
pause
