@echo off
REM Inicia o fan controller em MODO INTERATIVO (janela visivel p/ debug/testes)
cd /d "C:\Program Files\ipmicfg\app"
"C:\Program Files\nodejs\node.exe" fan_controller.js %*
pause
