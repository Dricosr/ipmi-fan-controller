@echo off
REM Valida o acesso IPMI + comportamento das fans (usa o proprio app)
cd /d "C:\Program Files\ipmicfg\app"
"C:\Program Files\nodejs\node.exe" fan_controller.js --validate
pause
