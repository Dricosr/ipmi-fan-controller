# 📖 Manual de Operação — IPMI Fan Controller (Tesla P100)

Controle **total das fans** (GPU + CPU + MB) por temperatura, com leitura via **web da BMC** +
controle via **IPMICFG raw**, rodando em **Node.js** com **web UI** local em `http://127.0.0.1:3041`.

> **Status:** operacional — validado na placa ASRock EP2C602 (dual Xeon E5-2670 v2 + Tesla P100).

---

## 1. Visão Geral

O app (`controller.js`) é um **processo único** que:
1. Lê os sensores via **HTTP da web da BMC** (`/rpc/getallsensors.asp`, ~100-300ms) + GPU local (`nvidia-smi`).
2. Calcula a duty de cada fan pela **curva** do sensor mapeado (`fanMapping`) — 3 curvas: `cpu`, `gpu` e `mobo`.
3. Aplica as 7 duties via `IPMICFG-Win.exe -raw 0x3a ...` (piso `globalMin=20%`).
4. Serve a **web UI** (Dashboard, Mapping, Curvas, Configuração) e o **teste de fan** por porta.

```
web BMC (getallsensors) + nvidia-smi ─▶ sensores ─▶ curvas ─▶ duties ─▶ IPMICFG 0x3a ─▶ fans
                                                    ▲                                   │
                                                    └──────────── web UI :3041 ◀────────┘
```

**Localização:** `C:\Program Files\ipmicfg\app`

---

## 2. Requisitos

| Item | Onde | Observação |
|------|------|------------|
| Node.js LTS | `C:\Program Files\nodejs\node.exe` | v24.19.0 |
| IPMICFG 1.27.1 | `C:\Program Files\ipmicfg\ipmi_1.27.1\Windows\64bit` | **1.38.0 não funciona** |
| nvidia-smi | `C:\Windows\System32\nvidia-smi.exe` | Driver NVIDIA DCH |
| Acesso web à BMC | `http://<endereco-bmc>` (ex.: 192.168.18.200) | Login admin |
| Permissão admin | — | Para gravar em `Program Files` e agendar tarefa |

---

## 3. Estrutura de Arquivos

| Arquivo | Função |
|---------|--------|
| `controller.js` | App único (leitura + controle + web UI) |
| `config.json` | Configuração (BMC, intervalo, curvas, fanMapping, fanNames) |
| `public/` | Web UI (HTML/JS/CSS): dashboard, mapping, curvas, configuração |
| `run_visible.bat` | Inicia o app em janela visível (debug) |
| `run_hidden.vbs` | Inicia oculto (usado no logon) |
| `setup_task.bat` | Registra a tarefa no logon (Task Scheduler) |
| `remove_task.bat` | Remove a tarefa do logon |
| `stop.bat` | Para o app e restaura o modo automático do BMC |
| `test_fan.bat` | Testa a conexão do app (web BMC + sensores) |
| `monitor_bmc.ps1` | Monitor de saúde + sinais de flood de sessões (rode sob demanda) |
| `README.md` | Resumo rápido |
| `logs\fan_controller.log` | Log do app (criado automaticamente) |

---

## 4. Configuração Inicial (1ª vez)

1. **Editar `config.json`** — principalmente `bmc.address` / `bmc.user` / `bmc.password`
   (a leitura de sensores é via HTTP da web da BMC) e o `sensor.interval`.
2. **Iniciar o app**:
   ```bat
   run_visible.bat
   ```
3. **Abrir a web UI**: `http://127.0.0.1:3041` → aba **Configuração** → **Testar conexão**
   (deve mostrar GPU + CPU/MB).
4. **Registrar no logon** (iniciar oculto a cada login):
   ```bat
   setup_task.bat
   ```

---

## 5. Como Executar

### Janela visível (debug/testes)
```bat
run_visible.bat
```
ou:
```
cd /d "C:\Program Files\ipmicfg\app"
"C:\Program Files\nodejs\node.exe" controller.js
```

### Oculto (produção — inicia no logon)
O `setup_task.bat` registra a tarefa `IPMI-FanController` (dispara no **logon**) que executa
`run_hidden.vbs` → `node controller.js` oculto.

Para iniciar agora sem esperar o logon:
```bat
schtasks /run /tn "IPMI-FanController"
```

---

## 6. Web UI e API

Abra **http://127.0.0.1:3041**:

| Página | Função |
|--------|--------|
| **Dashboard** | Temperaturas (GPU/CPU/MB) com fan atrelada e duty, tabela de fans (RPM/duty), voltagens, todos os sensores |
| **Mapping** | Porta → sensor + curva, prévia ao vivo (% calculada) e botão **Test** por fan |
| **Curvas** | Edita as curvas **CPU**, **GPU** e **MOBO** (pontos temperatura → %) |
| **Configuração** | Endereço/usuário/senha da BMC, intervalo de leitura, testar conexão e **Reiniciar BMC** (cold reset) |

### Endpoints da API
| Endpoint | Descrição |
|----------|-----------|
| `GET /api/state` | Sensores, duties, fanMapping, teste ativo |
| `GET /api/config` | Configuração atual (senha mascarada, curvas, mapping) |
| `PUT /api/config` | Salva configuração (aplica na hora) |
| `GET /api/test` | Testa conexão (GPU + CPU/MB via web BMC) |
| `POST /api/fan/<slot>/test` | Acelera a fan do slot a 100% por `testDurationSec` e volta |
| `POST /api/bmc/reset` | Cold reset da BMC (`IPMICFG -r`) — use quando a web da BMC travar |

---

## 7. Configuração (`config.json`)

```json
{
  "server": { "host": "127.0.0.1", "port": 3041 },
  "bmc": { "address": "192.168.18.200", "user": "admin", "password": "admin" },
  "sensor": { "interval": 3 },
  "fanNames": ["CPU_FAN1","REAR_FAN1","REAR_FAN2","FRNT_FAN1","FRNT_FAN2","FRNT_FAN3","FRNT_FAN4","CPU_FAN2"],
  "ipmi": { "dir": "C:\\Program Files\\ipmicfg\\ipmi_1.27.1\\Windows\\64bit" },
  "behavior": { "interval": 5, "globalMin": 20, "testDurationSec": 10 },
  "curves": {
    "cpu": { "35": 0, "40": 10, "50": 25, "60": 70, "65": 100 },
    "gpu": { "35": 0, "38": 10, "40": 20, "45": 40, "50": 60, "55": 70, "60": 80, "65": 100 },
    "mobo": { "35": 0, "38": 20, "41": 40, "44": 60, "47": 80, "50": 100 }
  },
  "fanMapping": {
    "1": { "sensor": "cpu_bsp1", "curve": "cpu" },
    "2": { "sensor": "mb", "curve": "mobo" },
    "3": { "sensor": "mb", "curve": "mobo" },
    "4": { "sensor": "gpu", "curve": "gpu" },
    "5": { "sensor": "mb", "curve": "mobo" },
    "6": { "sensor": "mb", "curve": "mobo" },
    "7": { "sensor": "mb", "curve": "mobo" }
  },
  "log": { "dir": "logs", "file": "fan_controller.log" }
}
```

| Chave | Descrição | Default |
|-------|-----------|---------|
| `server.host` / `server.port` | Onde a web UI escuta | `127.0.0.1` / `3041` |
| `bmc.address` | Endereço da BMC (web HTTP) — **obrigatório** p/ leitura | — |
| `bmc.user` / `bmc.password` | Credenciais da web da BMC | `admin` / `admin` |
| `sensor.interval` | Segundos entre leituras/atualizações (1–60) | `3` |
| `fanNames` | Nomes **físicos** (silkscreen) das 8 portas | ver acima |
| `ipmi.dir` | Pasta do IPMICFG 1.27.1 | `...\ipmi_1.27.1\Windows\64bit` |
| `behavior.globalMin` | Duty mínima (nunca `0x00` — quirk do BMC) | `20` |
| `behavior.testDurationSec` | Duração do teste de fan (segundos) | `10` |
| `curves.cpu` / `curves.gpu` / `curves.mobo` | Curvas temperatura → velocidade (%) — CPU, GPU e Placa-Mãe | ver acima |
| `fanMapping` | Porta → `{ sensor, curve }` (portas 1–7) | ver acima |
| `log.dir` / `log.file` | Caminho do log | `logs` / `fan_controller.log` |

> ⚠️ **Quirk do BMC:** a fan da P100 **só acelera quando TODAS as slots recebem duty** (com `0x00`
> nas demais ela trava no mínimo). Por isso `globalMin: 20` — o app **nunca** envia `0x00`.

---

## 8. Curvas de Temperatura

As três curvas (edite na aba **Curvas** da web UI ou em `config.json`):

| Curva | Pontos (temperatura → %) |
|-------|--------------------------|
| **CPU** | 35°→0% · 40°→10% · 50°→25% · 60°→70% · 65°→100% |
| **GPU** | 35°→0% · 38°→10% · 40°→20% · 45°→40% · 50°→60% · 55°→70% · 60°→80% · 65°→100% |
| **MOBO** (Placa-Mãe) | 35°→0% · 38°→20% · 41°→40% · 44°→60% · 47°→80% · 50°→100% |

> A curva **MOBO** (sensor `mb`) é mais agressiva — 100% a 50 °C — para refrigerar os VRMs/PCH e o
> gabinete. Toda duty é limitada ao piso `globalMin` (20%): abaixo do 1º ponto a fan fica em 20%.
> O app usa o **maior ponto** cuja temperatura é ≤ à lida.

---

## 9. Operação em Produção

1. Configure `config.json` (BMC, intervalo, curvas, mapping).
2. Inicie e valide: `run_visible.bat` + aba **Configuração** → **Testar conexão**.
3. Registre no logon: `setup_task.bat`.
4. A cada logon o app sobe oculto e controla as fans.

**Monitorar** sem abrir janela:
```bat
type "C:\Program Files\ipmicfg\app\logs\fan_controller.log"
```
Ou em PowerShell: `Get-Content ...\fan_controller.log -Tail 30`.

O log registra as duties aplicadas (ex.: `fans: CPU_FAN1=25% REAR_FAN1=20% ... FRNT_FAN1=40% ...`).

---

## 10. Parada e Remoção

| Ação | Comando |
|------|---------|
| Parar o app (limpo) + restaurar auto | `stop.bat` |
| Remover a tarefa do logon | `remove_task.bat` |
| Verificar a tarefa | `schtasks /query /tn "IPMI-FanController"` |

> **Importante:** use `stop.bat` (mata o `controller.js` e restaura o modo automático do BMC).
> O app também restaura o auto e **faz logout da sessão da BMC** se encerrado com Ctrl+C/SIGTERM
> (evita deixar sessão órfã, que contribuiria para o flood).

---

## 11. Validação e Testes

- **Teste de conexão:** aba **Configuração** → **Testar conexão**, ou `test_fan.bat`
  (chama `GET /api/test` do app em execução).
- **Teste de fan:** aba **Mapping** → botão **Test** na linha da fan — acelera a fan a **100%**
  por `testDurationSec` (default 10s) e volta ao controle normal.
- **Log:** cada mudança de duty é registrada; erros de leitura aparecem com motivo
  (`leitura instável...` / `FALLBACK...`).

---

## 12. Solução de Problemas

| Sintoma | Causa provável | Solução |
|---------|----------------|---------|
| `login HTTP da BMC falhou` | Credenciais/endereço errados | Corrigir `bmc.*` no `config.json` / aba Configuração |
| `getallsensors HTTP status ...` | BMC web inacessível (IP/rede) | Verificar `bmc.address` e conectividade |
| `FALLBACK ... fans a 100%` | Leitura falhou 2 ticks seguidos | Verificar rede/credenciais; o app recupera sozinho |
| `Can not find a valid IPMI device` | IPMICFG fora da pasta certa, ou 1.38.0 | Usar `ipmi_1.27.1\Windows\64bit` como `ipmi.dir` |
| `Completion Code=C7h` ao setar | Nº de argumentos errado | O comando manual é `0x3a 0x01 0x00` + **7 duties** |
| Fan não muda de velocidade | Fan não detectada ou porta errada | Conferir na aba Mapping com o botão Test |
| Fan da P100 travada (~1800 RPM) | `globalMin` em `0` (envia `0x00`) | Manter `behavior.globalMin: 20` |
| Modo ficou manual após morte do app | Processo morto à força | Rodar `stop.bat` |
| PowerShell corrompe `-raw` | PowerShell altera a formatação | Não digitar `-raw` manualmente no PowerShell; usar o app |
| Web da BMC travou (sem resposta) | Tabela de sessões cheia (flood) | Botão **Reiniciar BMC** (Configuração) ou `IPMICFG-Win.exe -r`; se o IPMI também morrer, desligar da tomada ~30s |
| Muitos `login #N` no log / `HTTP 503` | Flood de sessões na BMC | Rodar `monitor_bmc.ps1`; o app mantém 1 sessão (logout com retry) |

---

## 13. Mapeamento das Fans

A BMC expõe **7 slots de duty** (+ modo) via `0x3a`; a **8ª fan não é controlável** por este comando.
**Importante:** a BMC **nomeia os slots de forma deslocada** em relação ao silkscreen da placa.
O app usa os nomes **físicos** (silkscreen) no controle/UI:

| Slot | Nome físico (UI) | Nome que a BMC reporta | Controlável? |
|------|------------------|------------------------|--------------|
| 1 | CPU_FAN1 | CPU_FAN1 | ✅ |
| 2 | REAR_FAN1 | CPU_FAN2 | ✅ |
| 3 | REAR_FAN2 | REAR_FAN1 | ✅ |
| 4 | **FRNT_FAN1** (GPU P100) | REAR_FAN2 | ✅ (curva GPU) |
| 5 | FRNT_FAN2 | FRNT_FAN1 | ✅ |
| 6 | FRNT_FAN3 | FRNT_FAN2 | ✅ |
| 7 | FRNT_FAN4 | FRNT_FAN3 | ✅ |
| 8 | CPU_FAN2 | FRNT_FAN4 | ❌ (auto da BMC) |

> A ventoinha adaptada da **Tesla P100** está na **FRNT_FAN1 = slot 4** (curva GPU). A 8ª fan
> (**CPU_FAN2**) não é alcançada pelo comando `0x3a` e permanece sob controle automático da BMC.

---

## 14. Notas de Segurança

- ⚠️ **Quirk do BMC:** com duty `0x00` nas outras slots, a fan da P100 **fica travada no mínimo**.
  Por isso o app usa `behavior.globalMin: 20` — nunca envia `0x00`.
- Se a **leitura falhar por 2 ticks consecutivos**, o app manda **todas as fans a 100%** (seguro) e
  recupera sozinho quando a leitura voltar.
- Se o processo for morto à força, o BMC fica em manual até `stop.bat` ou o reboot.
- Monitore o log periodicamente.
