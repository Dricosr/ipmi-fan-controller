@echo off
REM Para o app (controller.js) e restaura o modo automatico do BMC
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*controller.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo.
echo App encerrado (se estava rodando). Restaurando modo auto...
cd /d "C:\Program Files\ipmicfg\ipmi_1.27.1\Windows\64bit"
IPMICFG-Win.exe -raw 0x3a 0x01 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00
echo Estado:
IPMICFG-Win.exe -raw 0x3a 0x02
pause
