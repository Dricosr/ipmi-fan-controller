# monitor_bmc.ps1 — Observa flood de sessões/requisições na BMC e saúde do controller.
# Uso:  powershell -ExecutionPolicy Bypass -File monitor_bmc.ps1
# (ou simplesmente: & 'C:\Program Files\ipmicfg\app\monitor_bmc.ps1')

$log   = 'C:\Program Files\ipmicfg\app\logs\fan_controller.log'
$state = 'http://127.0.0.1:3041/api/state'

Write-Host ('===== Monitor BMC @ ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====') -ForegroundColor Cyan

# 1) Saúde do app / BMC (via API local)
try {
  $s = (Invoke-WebRequest -UseBasicParsing $state -TimeoutSec 6).Content | ConvertFrom-Json
  $duties = ($s.duties -join ' ')
  "APP: ok=$($s.sensors.ok) | duties=[$duties] | gpu=$($s.sensors.gpu)C bsp1=$($s.sensors.temps.cpu_bsp1)C mb=$($s.sensors.temps.mb)C | err='$($s.error)'"
} catch {
  "APP: FALHA ao consultar $state -> $($_.Exception.Message)"
}

# 2) Indicadores de flood no log (últimas 200 linhas)
$tail = Get-Content $log -Encoding UTF8 -Tail 200
$loginN     = ($tail | Select-String -Pattern 'BMC: login #\d+').Count
$loginLast  = ($tail | Select-String -Pattern 'BMC: login #\d+' | Select-Object -Last 1).Line
$logoutOk   = ($tail | Select-String -Pattern 'logout sessão antiga .* ok').Count
$logoutBad  = ($tail | Select-String -Pattern 'logout sessão antiga .* (falhou|status)').Count
$retry      = ($tail | Select-String -Pattern 'leitura falhou .* re-login').Count
$slow       = ($tail | Select-String -Pattern 'leitura lenta').Count
$f503       = ($tail | Select-String -Pattern '503').Count
$tickTout   = ($tail | Select-String -Pattern 'controlTick timeout').Count
$fallback   = ($tail | Select-String -Pattern 'FALLBACK').Count
$setFail    = ($tail | Select-String -Pattern 'set falhou').Count

"LOG: logins=$loginN | logoutOK=$logoutOk | logoutFALHA=$logoutBad | re-loginX=$retry | lenta=$slow | HTTP503=$f503 | tickTimeout=$tickTout | FALLBACK=$fallback | setFalhou=$setFail"
if ($loginLast) { "ultimo login : $loginLast" }

# 3) Semáforo de risco
$risco = @()
if ($logoutBad -gt 0)    { $risco += 'logout a falhar -> sessões acumulam (risco flood!)' }
if ($retry -gt 0)        { $risco += 'leitura falhou + re-login -> ciclo de sessões (risco flood!)' }
if ($slow -gt 0)         { $risco += 'leituras lentas -> BMC sobrecarregada' }
if ($f503 -gt 0)         { $risco += 'HTTP 503 -> tabela de sessões cheia (flood CONFIRMADO)' }
if ($tickTout -gt 0)     { $risco += 'controlTick timeout -> loop de controlo preso' }
if ($fallback -gt 0)     { $risco += 'FALLBACK ativo -> BMC sem comunicação' }
if ($setFail -gt 0)      { $risco += 'set de fans falhou' }
if ($risco.Count -eq 0)  { Write-Host 'STATUS: OK - sem sinais de flood' -ForegroundColor Green }
else                     { $risco | ForEach-Object { Write-Host ('ATENCAO: ' + $_) -ForegroundColor Yellow } }
