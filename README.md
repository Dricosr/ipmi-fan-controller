# 🌀 IPMI Fan Controller — Tesla P100

> Controle automático de ventoinha da **NVIDIA Tesla P100** pela temperatura da GPU, via **IPMI raw**
> em um servidor **ASRock EP2C602** (dual Xeon E5-2670 v2). Feito em **Node.js**, sem dependências.

![Node](https://img.shields.io/badge/Node.js-24.19.0-339933?logo=nodedotjs)
![Platform](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows)
![Deps](https://img.shields.io/badge/dependencies-0-4BC51D)
![Status](https://img.shields.io/badge/status-validated-2E8B57)

---

## 🎯 Motivação

A Tesla P100 (250 W) em servidor 1U tem uma ventoinha que parece um **motor de jato**. O problema:

- A placa **ASRock EP2C602** usa BMC **ASPEED AST2300**, cujo **controle de ventoinhas NÃO existe na
  interface web** do BMC.
- No modo automático, o BMC decide a velocidade sozinho — e não deixa você ajustar.
- O ruído é insuportável em idle, e você quer garantir **100% de resfriamento** antes de a GPU esquentar.

A solução: **assumir o controle do BMC via comandos IPMI raw**, ler a temperatura da GPU com o
`nvidia-smi` e pilotar a ventoinha por uma curva de temperatura. **Automático, discreto e no boot.**

---

## 🧗 O Desafio (engenharia reversa)

Nenhum dos caminhos "fáceis" funcionou:

| Tentativa | Resultado |
|-----------|-----------|
| Controlar fan pela **interface web do BMC** | ❌ Não existe essa opção |
| IPMICFG **1.38.0** (a mais nova) | ❌ `Can not find a valid IPMI device` |
| Comandos **NetFn `0x30`** (padrão Supermicro) | ❌ `C1h` (comando inválido) |
| Comando **`-fan`** (padrão Supermicro) | ❌ `C1h` na ASRock |
| **Script PowerShell** com os comandos | ❌ PowerShell **corrompe os argumentos** |
| IPMICFG rodando **fora da própria pasta** | ❌ Não carrega `pmdll.dll` |

O que **funcionou** (via engenharia reversa):

- **NetFn `0x3a`** é o comando OEM da **ASRock** — único que responde.
- Comando manual exige **exatamente 10 argumentos**: `0x3a 0x01 <modo> <7 duties>`.
- O comando aceita **qualquer duty de 0x00 a 0x64** (0–100%).
- Só **7 slots de duty** são expostos (a 8ª fan não é alcançável por esse comando).
- **Node.js `spawn`** passa os argumentos sem o shell → resolve o problema do PowerShell.

> A saga completa está documentada em `MANUAL_OPERACAO.md` (seção de solução de problemas).

---

## 🏗️ Stack

| Camada | Tecnologia | Por quê |
|--------|------------|---------|
| **Linguagem** | **Node.js 24 LTS** | `spawn` passa args como array (sem o bug do PowerShell); zero deps |
| **Leitura de temperatura** | `nvidia-smi` (execFile) | Já vem com o driver NVIDIA |
| **Controle das fans** | `IPMICFG-Win.exe` **1.27.1** via `-raw 0x3a ...` | Única forma de acessar o BMC ASRock |
| **Inicialização no logon** | **Task Scheduler** + `run_hidden.vbs` | Roda oculto a cada logon |
| **Log/verificação** | `fs.appendFileSync` + readback do BMC | Garante que o duty foi aplicado (PASS/FAIL) |
| **Configuração** | `config.json` | Curva, fan, intervalo — tudo editável |

**Zero dependências npm.** Só built-ins: `child_process`, `fs`, `readline`.

---

## ⚙️ Como funciona

```
┌────────────┐   nvidia-smi   ┌──────────────┐   curva   ┌──────────────┐   IPMI raw   ┌─────────┐
│  GPU (P100) │ ─────────────▶ │ temperatura  │ ────────▶ │ velocidade   │ ────────────▶ │  BMC    │
└────────────┘                 └──────────────┘           │ alvo (%)     │              │  fans   │
                                                          └──────────────┘              └─────────┘
                                                                  │
                                                                  ▼
                                                        readback (0x3a 0x02)
                                                        verifica duty == alvo
                                                        → log PASS/FAIL
```

A cada **5 s** (configurável):
1. Lê a temperatura da GPU
2. Calcula a velocidade alvo pela curva
3. **Só envia comando ao BMC se a velocidade mudou**
4. Lê de volta e registra `PASS`/`FAIL` no log

---

## ✨ Funcionalidades

- 🎚️ **Curva de temperatura** configurável — hoje: **100% a 65 °C**
- 📋 **Enumera as fans** do BMC (`-sdr`) e lista em uma interface interativa
- 🧪 **Testa uma fan** (`testar fan 5`): ramp 20→50→80→100 com readback, restaura auto no final
- 🎛️ **Seta manualmente** (`set fan 5 80`) e alterna de volta com `auto`
- 🖥️ **Interativo ou daemon oculto** (inicia no logon)
- 🛡️ **Fail-safe**: se a GPU falhar, restaura o modo automático do BMC
- 🔒 **Single-instance** (lock file)
- ✅ **Validado** contra o hardware real (todos os passos PASS)

---

## 📁 Estrutura do projeto

```
ipmicfg/app
├── fan_controller.js     # App principal (Node, zero deps)
├── config.json           # Fan, curva, intervalo, piso
├── README.md             # Este arquivo
├── MANUAL_OPERACAO.md    # Manual de operação completo (PT)
├── run_visible.bat       # Modo interativo (console)
├── run_hidden.vbs        # Daemon oculto (logon)
├── setup_task.bat        # Registra tarefa no logon
├── remove_task.bat       # Remove tarefa do logon
├── stop.bat              # Para o daemon + restaura auto
├── test_fan.bat          # Validação completa do IPMI
└── logs/                 # Logs gerados (gitignored)
```

---

## 🚀 Começando

**Requisitos:** Node.js 24+ · IPMICFG 1.27.1 · driver NVIDIA com `nvidia-smi` · admin

```bat
:: 1. Validar o acesso ao IPMI (1.27.1 na pasta própria)
test_fan.bat

:: 2. Testar interativamente (lista fans, testa, seta)
run_visible.bat
> list
> testar fan 5
> set fan 5 80
> exit

:: 3. Registrar para iniciar oculto no logon
setup_task.bat
```

### Modos CLI
```bat
node fan_controller.js               :: interativo
node fan_controller.js --daemon      :: loop contínuo oculto
node fan_controller.js --validate    :: validação completa do IPMI
node fan_controller.js --once        :: 1 ciclo (teste rápido)
node fan_controller.js --diag        :: diagnóstico (saída crua)
```

### Config principal (`config.json`)
```json
{
  "fan": { "position": 5, "name": "FRNT_FAN1" },
  "ipmi": { "dir": "C:\\Program Files\\ipmicfg\\ipmi_1.27.1\\Windows\\64bit" },
  "behavior": { "interval": 5, "otherFansMode": "auto", "otherFansFloor": 40 },
  "tempCurve": { "30": 25, "40": 40, "50": 60, "60": 80, "65": 100 }
}
```
A fan **pos 5 = FRNT_FAN1** é a ventoinha da Tesla P100.

---

## 🧪 Validação (hardware real — 04/08/2026)

| Teste | Resultado |
|-------|-----------|
| Ler estado (`0x3a 0x02`) | ✅ `01 00 00 00 00 00 00 00` |
| Modo automático | ✅ `01` |
| Listar fans (`-sdr`) | ✅ 8 sensores, 5 com fan |
| Manual 40% em todas | ✅ readback `00 28 28 28 28 28 28 28` |
| Per-fan (só a escolhida) | ✅ demais fans **continuam girando** (seguro) |
| Ramp 20/50/80/100 | ✅ 6/6 PASS |
| Restaurar automático | ✅ `01 00 00 00 00 00 00 00` |

Saída real de um ciclo:
```
[2026-08-04 20:16:40] GPU 49C -> 40% [PASS] (FRNT_FAN1 duty=28)
```

---

## 🗺️ Ideias futuras

- [ ] Dashboard web (Flask/Node + HTML) para monitorar temp/duty
- [ ] Notificações (webhook/Discord) quando a GPU passar de X °C
- [ ] Múltiplas fans em curvas independentes
- [ ] Instalador `.msi` / pacote como serviço Windows

---

## 📜 Licença

Projeto pessoal. IPMICFG é da Supermicro (não redistribuído aqui — apenas usado localmente).

