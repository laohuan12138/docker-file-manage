@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   dockfile — Docker 容器文件管理器
echo   正在启动，浏览器会自动打开...
echo.
node server.js --open %*
if errorlevel 1 pause
