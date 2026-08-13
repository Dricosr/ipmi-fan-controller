@echo off
REM Testa a conexao do app em execucao (web BMC + sensores) via API
powershell -NoProfile -Command "$r = Invoke-RestMethod -Uri 'http://127.0.0.1:3041/api/test' -TimeoutSec 8; if ($r.ok) { Write-Host ('OK - GPU ' + $r.gpu + 'C - CPU ' + $r.cpu + 'C - MB ' + $r.mb + 'C - leitura ' + $r.mode) } else { Write-Host ('FALHA - ' + $r.error); exit 1 }"
pause
