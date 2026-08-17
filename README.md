# 🌀 IPMI Fan Controller — Tesla P100

> Controle **total das fans** por temperatura (GPU + CPU + MB) em um servidor **ASRock EP2C602**
> (dual Xeon E5-2670 v2, BMC ASPEED AST2300 / Megarac SP). Feito em **Node.js, sem dependências**,
> com **web UI** local.

![Node](https://img.shields.io/badge/Node.js-24.19.0-339933?logo=nodedotjs)
![Platform](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows)
![Deps](https://img.shields.io/badge/dependencies-0-4BC51D)
![Status](https://img.shields.io/badge/status-operational-2E8B57)

---

## 🎯 Motivação

A **NVIDIA Tesla P100** (250 W) **não tem ventoinha de fábrica** — é refrigerada de forma passiva.
Para o nosso servidor adaptamos uma **HA 8020 H1 2SBZ** (80 mm, 12 V, PWM) no cooler da GPU, ligada
na porta **FRNT_FAN1** da placa.

A placa **ASRock EP2C602** **não controla a velocidade dessa fan pelos recursos nativos** da BIOS e
não lê a temperatura da GPU. Este app lê **todos** os sensores (GPU via `nvidia-smi`, CPU/MB via a
web da BMC) e controla **todas as fans** por curvas de temperatura, via **IPMI raw** no BMC.

> **Resultado:** fans silenciosas em idle e 100% quando necessário, com **web UI** de monitoramento
> (Dashboard, Mapping, Curvas, Configuração), **teste de fan** por porta e **reinício da BMC**.

---

## 🧗 O Desafio (engenharia reversa)

| Tentativa | Resultado |
|-----------|-----------|
| Velocidade da fan via **BIOS nativa** | ❌ Não controla a fan da P100 |
| IPMICFG **1.38.0** (a mais nova) | ❌ `Can not find a valid IPMI device` |
| Comandos NetFn `0x30` (padrão Supermicro) | ❌ Inválidos na ASRock |
| **Script PowerShell** com IPMICFG | ❌ PowerShell corrompe os argumentos |
| IPMICFG rodando **fora da própria pasta** | ❌ Não carrega `pmdll.dll` |

O que **funcionou**:
- **NetFn `0x3a`** é o comando OEM da **ASRock** — único que responde (`0x3a 0x01 <modo> <7 duties>`).
- **Leitura de sensores rápida** via HTTP da web da BMC (`/rpc/getallsensors.asp`) — ~100-300ms
  (vs 6-9s do `-sdr` in-band).
- **Node.js `spawn`** passa os argumentos sem o shell → resolve o problema do PowerShell.

---

## 🏗️ Stack

| Camada | Tecnologia | Por quê |
|--------|------------|---------|
| **Linguagem** | **Node.js 24 LTS** | `spawn` passa args como array; zero deps |
| **Leitura de sensores** | HTTP da **web da BMC** (`getallsensors.asp`) + `nvidia-smi` (GPU) | ~100-300ms por leitura |
| **Controle das fans** | `IPMICFG-Win.exe` **1.27.1** via `-raw 0x3a ...` ([download](https://www.supermicro.com/wdl/utility/IPMICFG/Previous%20Releases/)) | Única forma de acessar o BMC ASRock |
| **Web UI** | Node `http` puro (sem deps) | Dashboard/Mapping/Curvas/Config em `localhost:3041` |
| **Inicialização no logon** | **Task Scheduler** + `run_hidden.vbs` | Roda oculto a cada logon |
| **Configuração** | `config.json` | BMC, intervalo, curvas, fanMapping, fanNames |

**Zero dependências npm.** Só built-ins: `child_process`, `fs`, `path`, `http`.

---

## ⚙️ Como funciona

```
 web BMC (getallsensors) + nvidia-smi ─▶ sensores (GPU/CPU/MB, RPM) ─▶ curvas ─▶ duties ─▶ IPMICFG 0x3a ─▶ fans
                                                                                                            │
                                                                                                            ▼
                                              web UI localhost:3041 (dashboard ao vivo, mapping, teste)
```

A cada `sensor.interval` (default 3s):
1. Lê os sensores via HTTP da web da BMC (+ GPU local via `nvidia-smi`).
2. Calcula a duty de cada fan pela curva do sensor mapeado (`fanMapping`) — 3 curvas: `cpu`, `gpu` e `mobo` (Placa-Mãe).
3. Envia as 7 duties via IPMICFG `0x3a` (piso `globalMin=20%` — nunca `0x00`).
4. Loga as duties aplicadas. Falha de leitura por 2 ticks → fans a 100% (seguro).

---

## 🔐 Sessão única da BMC (anti-flood)

A BMC **Megarac SP (AMI)** tem uma **tabela de sessões limitada**. Se o app criar sessões sem
liberá-las, a tabela enche e a **web da BMC para de responder** (travamento). O app mantém
**uma única sessão**:

- **Login** só quando não há sessão, ou quando a BMC rejeita a sessão atual (`302`/`401`/página de login).
- **Timeout/5xx/503** (BMC lenta ou cheia) **não** gera novo login — mantém a sessão (evita storm).
- **Logout** da sessão antiga ao renovar, com **retry 3×**; também no encerramento e ao mudar a config.
- **Throttle** de login: mínimo **5s** (após sucesso) / **30s** (após falha) entre logins.

**Se a BMC travar:** use o botão **Reiniciar BMC** (Configuração) ou, no shell, `IPMICFG-Win.exe -r`
(cold reset). Se até o IPMI morrer, desligue da tomada ~30s (o reboot do SO **não** reinicia o BMC).

**Monitor de flood:** `powershell -ExecutionPolicy Bypass -File monitor_bmc.ps1` — mostra saúde do app
e sinais de flood (nº de logins, logouts com falha, `HTTP 503`, re-logins, leituras lentas).

---

## 📁 Estrutura do projeto

```
ipmicfg/app
├── controller.js          # App único (leitura + controle + web UI)
├── config.json            # BMC, intervalo, curvas, fanMapping, fanNames
├── public/                # Web UI (HTML/JS/CSS): dashboard, mapping, curvas, config
├── monitor_bmc.ps1        # Monitor de saúde + sinais de flood de sessões (rode sob demanda)
├── README.md              # Este arquivo
├── MANUAL_OPERACAO.md     # Manual de operação completo (PT)
├── run_visible.bat        # Abre o app em janela visível (debug)
├── run_hidden.vbs         # Inicia oculto (usado no logon)
├── setup_task.bat         # Registra tarefa no logon
├── remove_task.bat        # Remove tarefa do logon
├── stop.bat               # Para o app + restaura modo automático do BMC
├── test_fan.bat           # Testa a conexão (web BMC + sensores)
└── logs/                  # Logs gerados (gitignored)
```

---

## 🚀 Começando

**Requisitos:** Node.js 24+ · IPMICFG 1.27.1 · driver NVIDIA com `nvidia-smi` · admin

> 📥 **IPMICFG** (use a versão **1.27.1**): https://www.supermicro.com/wdl/utility/IPMICFG/Previous%20Releases/

```bat
:: 1. Testar a conexão (com o app em execução)
test_fan.bat

:: 2. Rodar visível (debug)
run_visible.bat

:: 3. Registrar para iniciar oculto no logon
setup_task.bat
```

Depois, abra **http://127.0.0.1:3041** no navegador.

### Endpoints da API
- `GET /api/state` — sensores, duties, mapping, teste ativo
- `GET/PUT /api/config` — BMC, intervalo, curvas, fanMapping
- `GET /api/test` — teste de conexão (GPU + CPU/MB via web BMC)
- `POST /api/fan/<slot>/test` — acelera a fan escolhida a 100% por N segundos
- `POST /api/bmc/reset` — cold reset da BMC (`IPMICFG -r`); use quando a web da BMC travar

---

## ⚙️ Config principal (`config.json`)
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

> ⚠️ **Quirk do BMC:** a fan da P100 **só acelera quando TODAS as slots recebem duty** (com `0x00`
> nas demais ela trava no mínimo). Por isso o app usa `globalMin: 20` — **nunca** envia `0x00`.
>
> ⚠️ **Nomes físicos vs BMC:** a BMC nomeia os slots de forma deslocada. O `controller.js` usa os
> nomes **físicos** (silkscreen) no controle/UI (`fanNames`) e os nomes da BMC só para casar a leitura
> de RPM. A fan da GPU (P100) está na **FRNT_FAN1 = slot 4**. A 8ª fan (**CPU_FAN2**) não é
> controlável via `0x3a` (fica em auto da BMC).

---

## 🗺️ Ideias futuras
- [x] Dashboard web (Node + HTML) para monitorar temp/duty
- [x] Múltiplas fans em curvas independentes (mapping)
- [x] Teste de fan por porta (acelera e volta)
- [ ] Notificações (webhook/Discord) quando a GPU passar de X °C
- [ ] Instalador `.msi` / pacote como serviço Windows

---

## 📜 Licença

Projeto pessoal. IPMICFG é da Supermicro (não redistribuído aqui — apenas usado localmente).

