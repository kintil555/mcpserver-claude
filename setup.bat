@echo off
title MCP GitHub Push - Setup
cd /d "%~dp0"
if not exist "mcp-github-push-win-x64.exe" (
  echo ERROR: mcp-github-push-win-x64.exe tidak ditemukan di folder ini:
  echo   %~dp0
  echo.
  echo File ini harus ada DI FOLDER YANG SAMA dengan setup.bat.
  echo Kalau kamu pindahkan/rename exe-nya, pindahkan .bat ini juga ke folder yang sama.
  echo Download ulang dari: https://github.com/kintil555/mcpserver-claude/releases/latest
  echo.
  pause
  exit /b 1
)
mcp-github-push-win-x64.exe setup
echo.
pause
