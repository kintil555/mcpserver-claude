@echo off
title MCP GitHub Push - Status
cd /d "%~dp0"
mcp-github-push-win-x64.exe status
echo.
pause
