#!/usr/bin/env node
'use strict';
/*
 * fan_controller.js — Controle de ventoinha (Tesla P100) via IPMICFG raw (ASRock EP2C602)
 *
 * Uso:
 *   node fan_controller.js            Modo interativo (janela visivel, comandos em PT)
 *   node fan_controller.js --daemon   Modo oculto: loop automatico continuo (usado no logon)
 *   node fan_controller.js --once     Executa 1 ciclo do loop e sai (teste rapido)
 *   node fan_controller.js --validate Sequencia completa de validacao do IPMI
 *   node fan_controller.js --diag     Diagnostico: imprime saida crua dos comandos
 *
 * Comandos (modo interativo):
 *   list                  Lista todas as fans (pos, nome, RPM, duty)
 *   select <n>            Escolhe a fan do modo automatico (persiste no config)
 *   testar fan <n>        Testa a fan n: ramp 20->50->80->100->80->50->20 (restaura auto)
 *   set fan <n> <pct>     Seta a fan n em pct% (manual; use 'auto' p/ voltar)
 *   auto                  Restaura modo automatico (BMC)
 *   status                Temp GPU + modo + duty de todas as fans
 *   exit | sair           Encerra restaurando o modo automatico
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const IPMI_DIR = config.ipmi.dir;
const IPMI_EXE = path.join(IPMI_DIR, 'IPMICFG-Win.exe');
const LOG_DIR = path.join(APP_DIR, config.log.dir || 'logs');
const LOG_FILE = path.join(LOG_DIR, config.log.file || 'fan_controller.log');

// Posicoes 1-8 (1-indexed). O BMC expoe 7 SLOTS de duty + 1 byte de modo (8 bytes de dados).
// Pos 1-7 -> slot = pos-1. Pos 8 (FRNT_FAN4) NAO e controlavel por este comando.
const FAN_SLOTS = 7;
const FAN_NAMES = ['CPU_FAN1','CPU_FAN2','REAR_FAN1','REAR_FAN2',
                   'FRNT_FAN1','FRNT_FAN2','FRNT_FAN3','FRNT_FAN4'];

const INTERVAL_MS = (config.behavior.interval || 5) * 1000;

let selectedFan = config.fan.position;            // 1-indexed
let manualPaused = false;                         // pausa o loop durante set/test manual
let lastTarget = null;
let gpuFailCount = 0;
let stopping = false;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* log de erro nao deve derrubar o app */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dutyHex(percent) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  return '0x' + v.toString(16).padStart(2, '0');
}

// token hex sem prefixo (ex.: "14") — usado p/ comparar com a leitura
function dutyToken(percent) {
  return dutyHex(percent).replace('0x', '').toUpperCase();
}

function runIpmi(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(IPMI_EXE, args, { cwd: IPMI_DIR, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e) });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out, err }); });
  });
}

function runCmd(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}

/* ------------------------------------------------------------------ */
/* GPU                                                                 */
/* ------------------------------------------------------------------ */

async function getGpuTemp() {
  const candidates = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe',
                      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
  for (const c of candidates) {
    const r = await runCmd(c, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']);
    const m = r.out.match(/\d+/);
    if (m) {
      const t = parseInt(m[0], 10);
      if (t >= 0 && t <= 200) return t;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* IPMI - fans                                                         */
/* ------------------------------------------------------------------ */

// Le status: 0x3a 0x02 -> bytes hex. byte[0] = modo (00 manual / 01 auto), resto = duties
async function readFanStatus() {
  const r = await runIpmi(['-raw', '0x3a', '0x02']);
  const txt = (r.out + ' ' + r.err).trim();
  const bytes = txt.match(/[0-9a-fA-F]{2}/g) || [];
  const mode = bytes.length ? bytes[0].toUpperCase() : null;
  const duties = bytes.slice(1).map(b => b.toUpperCase());
  return { valid: bytes.length > 0, mode, duties, raw: txt, code: r.code };
}

// Seta os 7 slots de duty (percentuais, slots 0-6 = posicoes 1-7)
async function setFans(duties7) {
  const args = ['-raw', '0x3a', '0x01', '0x00'];
  for (let i = 0; i < FAN_SLOTS; i++) args.push(dutyHex(duties7[i] != null ? duties7[i] : 0));
  return runIpmi(args);
}

async function setAuto() {
  return runIpmi(['-raw', '0x3a', '0x01', '0x01',
                  '0x00','0x00','0x00','0x00','0x00','0x00','0x00']);
}

// Lista fans via -sdr (nomes + RPM). Ordem SDR 17-24 == posicao 1-8.
async function listFans() {
  const r = await runIpmi(['-sdr']);
  const txt = r.out + '\n' + r.err;
  const fans = [];
  for (let i = 0; i < 8; i++) {
    const name = FAN_NAMES[i];
    const re = new RegExp('\\(' + (17 + i) + '\\)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\|\\s+([^|]+)\\|');
    const m = txt.match(re);
    const rpmRaw = m ? m[1].trim() : 'N/A';
    const detected = /RPM/.test(rpmRaw);
    fans.push({ position: i + 1, name, sdrId: 17 + i, rpm: rpmRaw, detected });
  }
  return { fans, raw: txt };
}

function speedForTemp(temp) {
  const curve = Object.entries(config.tempCurve).sort((a, b) => Number(a[0]) - Number(b[0]));
  let speed = config.behavior.minSpeed != null ? config.behavior.minSpeed : 20;
  for (const [t, s] of curve) if (temp >= Number(t)) speed = s;
  return speed;
}

// Constrói o array de 7 duties.
// applyToAll=true (default nesta placa): a fan da P100 SÓ responde quando TODAS as slots
// recebem duty (duty 0x00 nas outras = fan fica no mínimo). Logo, aplica a mesma % em todas.
function buildDuties(pct, fanPos) {
  const pos = fanPos || selectedFan;
  const duties = new Array(FAN_SLOTS).fill(0);
  if (config.behavior.applyToAll !== false) {
    duties.fill(pct);
  } else {
    if ((config.behavior.otherFansMode || 'auto') === 'floor') {
      duties.fill(config.behavior.otherFansFloor || 40);
    }
    if (pos <= FAN_SLOTS) duties[pos - 1] = pct;
  }
  return duties;
}

// Aplica a velocidade alvo (por padrão em todas as slots — ver buildDuties)
async function applySpeed(targetPct) {
  if (selectedFan > FAN_SLOTS) return { ok: false, reason: 'posicao ' + selectedFan + ' nao controlavel' };
  const duties = buildDuties(targetPct);
  const r = await setFans(duties);
  if (r.code !== 0) return { ok: false, reason: 'set falhou: ' + (r.err || r.out).trim() };
  const st = await readFanStatus();
  if (!st.valid) return { ok: false, reason: 'readback invalido: ' + st.raw };
  const want = dutyToken(targetPct);
  const got = st.duties[selectedFan - 1];
  return { ok: got === want, got, want, mode: st.mode, duties: st.duties };
}

/* ------------------------------------------------------------------ */
/* Loop automatico                                                     */
/* ------------------------------------------------------------------ */

async function loopTick() {
  if (manualPaused || stopping) return;
  const temp = await getGpuTemp();
  if (temp == null) {
    gpuFailCount++;
    log(`GPU indisponivel (falha ${gpuFailCount})`);
    if (gpuFailCount >= (config.behavior.gpuFailSafeTries || 3)) {
      log('Fail-safe: restaurando modo automatico do BMC');
      await setAuto();
    }
    return;
  }
  gpuFailCount = 0;
  const target = speedForTemp(temp);
  if (target !== lastTarget) {
    lastTarget = target;
    const res = await applySpeed(target);
    if (res.ok) log(`GPU ${temp}C -> ${target}% [PASS] (${FAN_NAMES[selectedFan-1]} duty=${res.got})`);
    else log(`GPU ${temp}C -> ${target}% [FAIL] ${res.reason}`);
  }
}

function startLoop() {
  log(`=== IPMI Fan Controller iniciado (loop ${INTERVAL_MS / 1000}s) ===`);
  loopTick();
  setInterval(loopTick, INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/* Validacao / Diagnostico                                             */
/* ------------------------------------------------------------------ */

async function cmdValidate() {
  log('=== VALIDACAO IPMI (1.27.1, cwd=' + IPMI_DIR + ') ===');
  let ok = true;

  log('-- 1. Ler estado (0x3a 0x02) --');
  let st = await readFanStatus();
  console.log('   raw: ' + st.raw + '  | modo=' + st.mode + ' duties=' + JSON.stringify(st.duties));
  if (!st.valid) { console.log('   [FAIL] nao conseguiu ler'); return 1; }

  log('-- 2. Restaurar auto --');
  await setAuto(); await sleep(500);
  st = await readFanStatus();
  console.log('   modo=' + st.mode + ' (esperado 01)');
  if (st.mode !== '01') { console.log('   [WARN] modo nao parece auto'); }

  log('-- 3. Listar fans (-sdr) --');
  const lf = await listFans();
  for (const f of lf.fans) {
    console.log(`   pos ${f.position}: ${f.name} (SDR ${f.sdrId}) -> ${f.rpm}${f.detected ? '' : '  [NAO DETECTADA]'}`);
  }

  log('-- 4. Manual 40% em todas as fans (7 slots) --');
  const r40 = await setFans([40,40,40,40,40,40,40]);
  console.log('   set code=' + r40.code + ' err=' + (r40.err.trim() || '(vazio)'));
  await sleep(800);
  st = await readFanStatus();
  console.log('   read: ' + st.raw);
  console.log('   esperado byte[1..] ~= 28 (40%)');

  log('-- 5. PER-FAN: fan escolhida=' + selectedFan + ' (' + FAN_NAMES[selectedFan-1] + ') a 60% (applyToAll=' + (config.behavior.applyToAll !== false) + ') --');
  const duties = buildDuties(60);
  const rp = await setFans(duties);
  await sleep(800);
  const stP = await readFanStatus();
  console.log('   set code=' + rp.code + ' | read: ' + stP.raw);
  const lf2 = await listFans();
  for (const f of lf2.fans) {
    if (f.detected) console.log(`   ${f.name}: ${f.rpm}`);
  }
  ok = ok && (selectedFan <= FAN_SLOTS && stP.duties[selectedFan - 1] === dutyToken(60));

  log('-- 6. Ramp 20/50/80/100 na fan escolhida --');
  for (const pct of [20, 50, 80, 100, 50, 20]) {
    const d = buildDuties(pct);
    await setFans(d);
    await sleep(600);
    const s = await readFanStatus();
    const got = s.duties[selectedFan - 1];
    const want = dutyToken(pct);
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`   ${pct}% -> duty=${got} (esperado ${want}) [${pass ? 'PASS' : 'FAIL'}]`);
  }

  log('-- 7. Restaurar auto --');
  await setAuto();
  await sleep(500);
  st = await readFanStatus();
  console.log('   modo=' + st.mode + ' | raw: ' + st.raw);
  log('=== VALIDACAO ' + (ok ? 'OK (sem falhas)' : 'COM FALHAS - revisar acima') + ' ===');
  return ok ? 0 : 1;
}

async function cmdDiag() {
  console.log('=== DIAG IPMI ===');
  console.log('IPMI_DIR =', IPMI_DIR);
  console.log('IPMI_EXE existe?', fs.existsSync(IPMI_EXE));
  console.log('--- 0x3a 0x02 (ler) ---');
  let r = await runIpmi(['-raw', '0x3a', '0x02']);
  console.log('code=' + r.code, 'out=[' + r.out.trim() + ']', 'err=[' + r.err.trim() + ']');
  console.log('--- set auto ---');
  r = await setAuto();
  console.log('code=' + r.code, 'out=[' + r.out.trim() + ']', 'err=[' + r.err.trim() + ']');
  console.log('--- -sdr (primeiras linhas) ---');
  r = await runIpmi(['-sdr']);
  console.log(r.out.split('\n').slice(0, 30).join('\n'));
}

/* ------------------------------------------------------------------ */
/* Interativo                                                          */
/* ------------------------------------------------------------------ */

async function cmdTestFan(n) {
  if (n < 1 || n > FAN_SLOTS) return console.log('Posicao invalida (1-' + FAN_SLOTS + '). Pos 8 (FRNT_FAN4) nao e controlavel.');
  manualPaused = true;
  log(`=== Testando fan ${n} (${FAN_NAMES[n-1]}) ===`);
  try {
    await setAuto(); await sleep(400);
    for (const pct of [20, 50, 80, 100, 80, 50, 20]) {
      const d = buildDuties(pct, n);
      await setFans(d);
      await sleep(700);
      const s = await readFanStatus();
      const got = s.duties[n - 1];
      const want = dutyToken(pct);
      const pass = got === want;
      console.log(`   ${FAN_NAMES[n-1]} ${pct}% -> duty=${got} [${pass ? 'PASS' : 'FAIL'}]`);
      log(`teste fan ${n}: ${pct}% ${pass ? 'PASS' : 'FAIL'}`);
    }
  } finally {
    await setAuto();
    manualPaused = false;
    lastTarget = null;
    log(`=== Fim do teste da fan ${n} - modo automatico restaurado ===`);
  }
}

async function cmdSetFan(n, pct) {
  if (n < 1 || n > FAN_SLOTS) return console.log('Posicao invalida (1-' + FAN_SLOTS + '). Pos 8 (FRNT_FAN4) nao e controlavel.');
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  manualPaused = true;
  const d = buildDuties(pct, n);
  await setFans(d);
  await sleep(600);
  const s = await readFanStatus();
  const got = s.duties[n - 1];
  const want = dutyToken(pct);
  const pass = got === want;
  console.log(`${FAN_NAMES[n-1]} setado ${pct}% -> duty=${got} [${pass ? 'PASS' : 'FAIL'}]`);
  log(`set fan ${n} ${pct}% ${pass ? 'PASS' : 'FAIL'} (loop pausado - use 'auto' p/ retomar)`);
}

async function cmdStatus() {
  const temp = await getGpuTemp();
  const st = await readFanStatus();
  console.log(`GPU: ${temp == null ? 'N/A' : temp + 'C'}`);
  console.log(`Modo IPMI: ${st.mode === '01' ? 'AUTO' : st.mode === '00' ? 'MANUAL' : st.mode} | Fan selecionada: ${selectedFan} (${FAN_NAMES[selectedFan-1]})`);
  for (let i = 0; i < FAN_NAMES.length; i++) {
    const duty = i < st.duties.length ? st.duties[i] : null;
    const pct = duty ? parseInt(duty, 16) : 0;
    const sel = i === selectedFan - 1 ? ' <--' : '';
    const nc = i >= FAN_SLOTS ? ' [nao controlavel]' : '';
    console.log(`  ${i + 1}) ${FAN_NAMES[i].padEnd(9)} duty=${duty} (${pct}%)${sel}${nc}`);
  }
}

async function cmdList() {
  const lf = await listFans();
  console.log('Fans disponíveis (1-' + FAN_SLOTS + ' controlaveis; pos 8 nao controlavel):');
  for (const f of lf.fans) {
    const sel = f.position === selectedFan ? ' <--' : '';
    const nc = f.position > FAN_SLOTS ? ' [nao controlavel]' : '';
    console.log(`  ${f.position}) ${f.name.padEnd(9)} ${f.rpm.padEnd(14)} ${f.detected ? '' : '[NAO DETECTADA]'}${sel}${nc}`);
  }
}

function cmdSelect(n) {
  if (n < 1 || n > FAN_SLOTS) return console.log('Posicao invalida (1-' + FAN_SLOTS + '). Pos 8 (FRNT_FAN4) nao e controlavel.');
  selectedFan = n;
  config.fan.position = n;
  config.fan.name = FAN_NAMES[n - 1];
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.log('nao consegui salvar config:', e.message); }
  lastTarget = null;
  log(`Fan selecionada: ${n} (${FAN_NAMES[n-1]}) - salva no config`);
  console.log(`Fan selecionada: ${n} (${FAN_NAMES[n-1]})`);
}

const HELP = `
Comandos:
  list                     Lista todas as fans
  select <n>               Escolhe a fan do modo automatico (salva no config)
  testar fan <n>           Testa fan n (ramp 20..100..20, restaura auto)
  set fan <n> <pct>        Seta fan n em pct% (manual; 'auto' retoma)
  auto                     Restaura modo automatico (BMC)
  status                   Temp GPU + duty de todas as fans
  exit | sair              Encerra (restaura auto)
`;

function interactive() {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  console.log('=== IPMI Fan Controller (Tesla P100) ===');
  cmdList();
  rl.setPrompt('> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const s = line.trim().toLowerCase();
    if (!s) { rl.prompt(); return; }
    try {
      if (/^(list|fans)$/.test(s)) await cmdList();
      else if (/^(select|selecionar)\s+(\d+)$/.test(s)) cmdSelect(parseInt(s.match(/(\d+)$/)[1], 10));
      else if (/^(testar|teste|test)\s+(a\s+)?fan\s+(\d+)$/.test(s)) await cmdTestFan(parseInt(s.match(/(\d+)$/)[1], 10));
      else if (/^(set|setar)\s+fan\s+(\d+)(?:\s+(\d+))?$/.test(s)) { const m = s.match(/^(set|setar)\s+fan\s+(\d+)(?:\s+(\d+))?$/); await cmdSetFan(parseInt(m[2], 10), m[3] != null ? parseInt(m[3], 10) : 50); }
      else if (/^auto$/.test(s)) { manualPaused = false; lastTarget = null; await setAuto(); log('Modo automatico restaurado (BMC) - loop retomado'); }
      else if (/^status$/.test(s)) await cmdStatus();
      else if (/^(exit|sair|quit)$/.test(s)) { rl.close(); await shutdown(); }
      else if (/^help$/.test(s)) console.log(HELP);
      else console.log('Comando nao reconhecido. Digite "help".');
    } catch (e) {
      console.log('Erro:', e.message);
    }
    rl.prompt();
  });
}

/* ------------------------------------------------------------------ */
/* Single instance + shutdown                                          */
/* ------------------------------------------------------------------ */

const LOCK_FILE = path.join(APP_DIR, 'fan_controller.lock');

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (oldPid) { try { process.kill(oldPid, 0); return false; } catch (_) {} }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (_) { return true; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('=== Encerrando - restaurando modo automatico ===');
  try { await setAuto(); } catch (_) {}
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--diag')) return cmdDiag().then(() => process.exit(0));
  if (args.includes('--validate')) return process.exit(await cmdValidate());

  if (!acquireLock()) {
    console.log('Outra instancia do fan_controller ja esta rodando.');
    process.exit(1);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.includes('--once')) {
    await loopTick();
    log('--once: ciclo executado.');
    return shutdown();
  }
  if (args.includes('--daemon')) {
    startLoop();
    log('Daemon em execucao (oculto). Encerrar restaurara o modo automatico.');
    return;
  }
  interactive();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
