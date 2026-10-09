@echo off
setlocal
set "SMARTPCB_NODE=D:\nodejs\node.exe"
if not exist "%SMARTPCB_NODE%" set "SMARTPCB_NODE=C:\Program Files\nodejs\node.exe"
if not exist "%SMARTPCB_NODE%" set "SMARTPCB_NODE=node"
pushd "%~dp0"
"%SMARTPCB_NODE%" smartpcb.js "fixtures\sample-board.json" "demo-result" "config.json"
if errorlevel 1 goto failed
start "" "%~dp0demo-result\report.html"
popd
exit /b 0
:failed
echo Demo failed. Read demo-result\error.txt.
popd
pause
exit /b 1
