@echo off
REM Registra a tarefa "IPMI-FanController" para rodar no LOGON (oculto, maxima prioridade)
schtasks /create /tn "IPMI-FanController" /tr "\"C:\Windows\System32\wscript.exe\" \"C:\Program Files\ipmicfg\app\run_hidden.vbs\"" /sc onlogon /rl highest /f
echo.
echo Tarefa criada. Verifique com:  schtasks /query /tn "IPMI-FanController"
pause
