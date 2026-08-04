@echo off
REM Remove a tarefa "IPMI-FanController" do logon
schtasks /delete /tn "IPMI-FanController" /f
echo.
echo Tarefa removida (se existia).
pause
