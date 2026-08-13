# 📖 Manual de Operação — IPMI Fan Controller (Tesla P100)

Controle automático da ventoinha da Tesla P100 (e demais fans) pela temperatura da GPU,
via comandos IPMI raw do IPMICFG (versão **1.27.1**), rodando em **Node.js**.

> **Status:** validado em 04/08/2026 na placa ASRock EP2C602 (dual Xeon + Tesla P100).
> Validação completa OK: leitura, modo manual/auto, ramp de velocidades e listagem de fans.

---

## 1. Visão Geral

O app roda em loop, lê a temperatura da GPU (`nvidia-smi`), calcula a velocidade alvo pela
curva de temperatura e aplica o duty na fan escolhida via `IPMICFG-Win.exe -raw 0x3a ...`.
A cada mudança de velocidade ele faz **readback** (lê de volta do BMC) e registra `PASS`/`FAIL`
no log — garantindo que o comando realmente foi aplicado.

```
GPU (nvidia-smi) → curva → velocidade alvo → BMC (IPMI raw) → readback → log
```

**Localização:** `C:\Program Files\ipmicfg\app`

---

## 2. Requisitos

| Item | Onde | Observação |
|------|------|------------|
| Node.js LTS | `C:\Program Files\nodejs\node.exe` | Instalado via winget (v24.19.0) |
| IPMICFG 1.27.1 | `C:\Program Files\ipmicfg\ipmi_1.27.1\Windows\64bit` | **1.38.0 não funciona** (não acha o BMC) |
| nvidia-smi | `C:\Windows\System32\nvidia-smi.exe` | Driver NVIDIA DCH |
| Permissão admin | — | Necessária p/ gravar em `Program Files` e agendar tarefa |

---

## 3. Estrutura de Arquivos

| Arquivo | Função |
|---------|--------|
| `fan_controller.js` | App principal (Node, sem dependências externas) |
| `config.json` | Configuração (fan, curva, intervalo, piso) |
| `run_visible.bat` | Inicia em modo **interativo** (janela, p/ testes) |
| `run_hidden.vbs` | Inicia em modo **daemon oculto** (usado no logon) |
| `setup_task.bat` | Registra a tarefa no logon (Task Scheduler) |
| `remove_task.bat` | Remove a tarefa do logon |
| `stop.bat` | Para o daemon e restaura o modo automático |
| `test_fan.bat` | Roda a validação completa do IPMI |
| `README.md` | Resumo rápido |
| `logs\fan_controller.log` | Log do app (criado automaticamente) |

---

## 4. Configuração Inicial (1ª vez)

1. **Verificar o IPMI** (só a 1.27.1 acessa o BMC):
   ```bat
   cd /d "C:\Program Files\ipmicfg\ipmi_1.27.1\Windows\64bit"
   IPMICFG-Win.exe -raw 0x3a 0x02
   ```
   Deve retornar 8 bytes (ex.: `01 00 00 00 00 00 00 00`). Erro `Can not find a valid IPMI device`
   = rodou fora da pasta certa (o app sempre roda com a pasta correta).

2. **Editar `config.json`** conforme necessário (ver seção 7).

3. **Validar** o acesso e o comportamento:
   ```bat
   test_fan.bat
   ```
   (equivale a `node fan_controller.js --validate`)

4. **Registrar no logon** (para iniciar oculto a cada login):
   ```bat
   setup_task.bat
   ```

---

## 5. Como Executar

### Modo interativo (console visível — recomendado p/ testes)
```bat
run_visible.bat
```
ou diretamente:
```
cd /d "C:\Program Files\ipmicfg\app"
"C:\Program Files\nodejs\node.exe" fan_controller.js
```

### Modo daemon oculto (produção — inicia no logon)
O `setup_task.bat` registra a tarefa `IPMI-FanController` que roda no **logon**, oculta,
via `run_hidden.vbs` (executa `node fan_controller.js --daemon`).

Para executar uma vez sem esperar o logon (teste do startup):
```bat
schtasks /run /tn "IPMI-FanController"
```

### Execuções pontuais
| Comando | Efeito |
|---------|--------|
| `node fan_controller.js --once` | Roda 1 ciclo (temp→curva→set→readback) e restaura auto |
| `node fan_controller.js --validate` | Validação completa do IPMI |
| `node fan_controller.js --diag` | Diagnóstico (saída crua dos comandos) |

---

## 6. Comandos do Modo Interativo

Ao rodar em modo interativo, aparece o prompt `>`. Comandos (case-insensitive):

| Comando | Descrição | Exemplo |
|---------|-----------|---------|
| `list` / `fans` | Lista todas as fans (pos, nome, RPM, detectada, selecionada) | `list` |
| `select <n>` | Escolhe a fan do modo automático (**salva no config**) | `select 5` |
| `testar fan <n>` | Testa a fan: ramp 20→50→80→100→80→50→20 com readback, **restaura auto no final** | `testar fan 5` |
| `teste a fan <n>` | Idem (variação da digitação) | `teste a fan 5` |
| `set fan <n> <pct>` | Seta a fan n em `pct`% (manual; o loop fica pausado até `auto`) | `set fan 5 80` |
| `set fan <n>` | Seta a fan n em **50%** (padrão) | `set fan 5` |
| `auto` | Restaura o modo automático do BMC e retoma o loop | `auto` |
| `status` | Mostra temp da GPU, modo IPMI, fan selecionada e duty de todas | `status` |
| `help` | Mostra a lista de comandos | `help` |
| `exit` / `sair` | Encerra restaurando o modo automático | `exit` |

Exemplo de sessão:
```
> list
> select 5
Fan selecionada: 5 (FRNT_FAN1) - salva no config
> testar fan 5
   FRNT_FAN1 20% -> duty=14 [PASS]
   FRNT_FAN1 50% -> duty=32 [PASS]
   ...
> set fan 5 80
FRNT_FAN1 setado 80% -> duty=50 [PASS]
> auto
> status
> exit
```

---

## 7. Configuração (`config.json`)

```json
{
  "fan": { "position": 5, "name": "FRNT_FAN1" },
  "ipmi": { "dir": "C:\\Program Files\\ipmicfg\\ipmi_1.27.1\\Windows\\64bit" },
  "behavior": {
    "interval": 5,
    "minSpeed": 20,
    "gpuFailSafe": "auto",
    "gpuFailSafeTries": 3,
    "applyToAll": true,
    "otherFansMode": "auto",
    "otherFansFloor": 40
  },
  "tempCurve": { "30": 25, "40": 40, "50": 60, "60": 80, "65": 100 },
  "log": { "dir": "logs", "file": "fan_controller.log" }
}
```

| Chave | Descrição | Default |
|-------|-----------|---------|
| `fan.position` | Porta da fan controlada (1–7). `5` = FRNT_FAN1 (Tesla P100) | `5` |
| `fan.name` | Nome descritivo (só p/ log/display) | `"FRNT_FAN1"` |
| `ipmi.dir` | Pasta do IPMICFG (1.27.1) | `...\ipmi_1.27.1\Windows\64bit` |
| `behavior.interval` | Segundos entre verificações de temperatura | `5` |
| `behavior.minSpeed` | Velocidade mínima da curva (abaixo do 1º ponto) | `20` |
| `behavior.gpuFailSafe` | Ação se a GPU falhar repetidamente (`auto` = restaura auto) | `"auto"` |
| `behavior.gpuFailSafeTries` | Nº de falhas seguidas antes do fail-safe | `3` |
| `behavior.applyToAll` | Aplica a curva em **todas** as slots (a fan da P100 só acelera se TODAS as slots têm duty ≠ 0x00 — quirk do BMC) | `true` |
| `behavior.otherFansMode` | Usado só se `applyToAll=false`: demais fans em `auto` (0x00) ou `floor` (piso) | `"auto"` |
| `behavior.otherFansFloor` | % mínimo das demais fans quando `otherFansMode=floor` | `40` |
| `tempCurve` | Mapa `temperatura → velocidade (%)` | ver acima |
| `log.dir` / `log.file` | Caminho do log | `logs` / `fan_controller.log` |

---

## 8. Curva de Temperatura

A curva atual (100% a 65 °C):
| Temperatura | Velocidade |
|-------------|------------|
| < 30 °C | 20 % (mínimo) |
| 30–39 °C | 25 % |
| 40–49 °C | 40 % |
| 50–59 °C | 60 % |
| 60–64 °C | 80 % |
| **≥ 65 °C** | **100 %** |

Para ajustar, edite `tempCurve` no `config.json`. O app usa o **maior ponto** cuja temperatura
é menor ou igual à lida.

---

## 9. Operação em Produção

1. Configure `config.json` (fan, curva, intervalo).
2. Valide com `test_fan.bat`.
3. Registre no logon: `setup_task.bat`.
4. A cada logon o daemon sobe oculto e começa a controlar a fan.

**Monitorar** sem abrir janela:
```bat
type "C:\Program Files\ipmicfg\app\logs\fan_controller.log"
```
Ou em PowerShell: `Get-Content ...\fan_controller.log -Tail 30`.

O log registra cada mudança de velocidade com `PASS`/`FAIL` (ex.:
`GPU 39C -> 20% [PASS] (FRNT_FAN1 duty=14)`).

---

## 10. Parada e Remoção

| Ação | Comando |
|------|---------|
| Parar o daemon (limpo) + restaurar auto | `stop.bat` |
| Remover a tarefa do logon | `remove_task.bat` |
| Verificar a tarefa | `schtasks /query /tn "IPMI-FanController"` |

> **Importante:** `schtasks /end` deixa o processo node órfão. Use `stop.bat` para parar de
> forma limpa (mata o daemon e restaura o modo automático do BMC).

---

## 11. Validação e Testes

`test_fan.bat` (ou `node fan_controller.js --validate`) executa:
1. Leitura do estado (`0x3a 0x02`) — não pode falhar
2. Restauração do modo automático
3. Listagem das fans (`-sdr`)
4. Manual 40% em todas → readback
5. Per-fan: só a escolhida com duty, demais 0x00 → confirma que as outras **continuam girando**
6. Ramp 20/50/80/100/50/20 → readback `PASS` em cada
7. Restauração do automático

Saída final: `=== VALIDACAO OK (sem falhas) ===`.

---

## 12. Solução de Problemas

| Sintoma | Causa provável | Solução |
|---------|----------------|---------|
| `Can not find a valid IPMI device` | IPMICFG rodando fora da própria pasta, ou versão 1.38.0 | Usar a pasta `ipmi_1.27.1\Windows\64bit` como `ipmi.dir` |
| `Completion Code=C7h` ao setar | Nº de argumentos errado | O comando manual é `0x3a 0x01 0x00` + **7 duties** (10 args) |
| `C1h` com `-fan` | Comando `-fan` não é suportado na ASRock | Usar apenas os `-raw 0x3a` (o app já faz isso) |
| Fan não muda de velocidade | Fan não detectada (sem RPM) ou porta errada | Ver `list`; conferir se a fan está ligada no header certo |
| `GPU indisponivel` no log | `nvidia-smi` sem resposta | Verificar driver/GPU; após 3 falhas o app restaura auto |
| Fan não sobe (~1800 RPM) mesmo com duty alto | **Quirk do BMC:** com `0x00` nas outras slots a fan da P100 fica no mínimo | Manter `behavior.applyToAll: true` (default) |
| Modo ficou manual após morte do daemon | Processo morto à força (sem `stop.bat`) | Rodar `stop.bat` ou `node fan_controller.js --once` (restaura auto) |
| Argumamentos corrompidos no PowerShell | PowerShell altera a formatação | Não digitar os `-raw` manualmente no PowerShell; usar o app/`.bat` |

---

## 13. Mapeamento das Fans

O BMC expõe **7 slots de duty** (+ 1 byte de modo) pelo comando `0x3a`:

| Posição | Nome | SDR | Status |
|---------|------|-----|--------|
| 1 | CPU_FAN1 | 17 | Controlável (conectada) |
| 2 | CPU_FAN2 | 18 | Controlável (conectada) |
| 3 | REAR_FAN1 | 19 | Controlável (conectada) |
| 4 | REAR_FAN2 | 20 | Controlável (conectada) |
| 5 | **FRNT_FAN1** (Tesla P100) | 21 | **Controlável (default)** |
| 6 | FRNT_FAN2 | 22 | Controlável se houver fan (hoje: sem fan) |
| 7 | FRNT_FAN3 | 23 | Controlável se houver fan (hoje: sem fan) |
| 8 | FRNT_FAN4 | 24 | **Não controlável** (comando não tem 8º slot) |

> Fan ligada em FRNT_FAN2/3 (pos 6/7) vira controlável com `select 6`/`select 7`.
> FRNT_FAN4 (pos 8) não é alcançada por este comando, mesmo com fan ligada.

---

## 14. Notas de Segurança

- ⚠️ **Quirk do BMC:** com duty `0x00` nas outras slots, a fan da P100 **fica travada no mínimo**
  (~1800 RPM) mesmo com duty 100% nela. Por isso o app usa `behavior.applyToAll: true` (default) —
  aplica a curva em todas as slots. Só desative se validar o contrário em outro hardware.
- O modo manual é **global**: ao controlar a fan escolhida, as demais entram em manual no BMC.
- Se o daemon for morto à força, o BMC fica em manual até o **reboot** ou próximo logon.
  Use `stop.bat` para parar de forma limpa.
- Monitore o log periodicamente para garantir `PASS` contínuo.
