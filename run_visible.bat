@echo off
REM Inicia o controller.js em JANELA VISIVEL (p/ debug/testes)
cd /d "C:\Program Files\ipmicfg\app"
"C:\Program Files\nodejs\node.exe" controller.js %*
pause
