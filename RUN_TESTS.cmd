@echo off
setlocal
set "SMARTPCB_NODE=D:\nodejs\node.exe"
if not exist "%SMARTPCB_NODE%" set "SMARTPCB_NODE=C:\Program Files\nodejs\node.exe"
if not exist "%SMARTPCB_NODE%" set "SMARTPCB_NODE=node"
pushd "%~dp0"
"%SMARTPCB_NODE%" test-placer.js
if errorlevel 1 goto failed
"%SMARTPCB_NODE%" test-router.js
if errorlevel 1 goto failed
"%SMARTPCB_NODE%" test-integration.js
if errorlevel 1 goto failed
echo SmartPCB tests passed.
popd
pause
exit /b 0
:failed
echo Test failed. Read the output above.
popd
pause
exit /b 1
