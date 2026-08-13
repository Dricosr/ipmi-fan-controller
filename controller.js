#!/usr/bin/env node
'use strict';
/*
 * controller.js — IPMI Fan Controller TOTAL (controle + UI web)
 *
 * Lê os sensores via HTTP da web da BMC (Megarac SP: getallsensors.asp) + GPU
 * local (nvidia-smi), controla as 7 fans em MANUAL via IPMICFG raw (0x3a) usando
 * o fanMapping (porta -> sensor + curva), serve a UI em http://127.0.0.1:3041
 * e permite testar cada fan (acelera a 100% por um tempo e volta ao controle normal).
 *
 * Segurança:
 *  - globalMin (nunca 0x00 -> evita o quirk do BMC que trava a fan da GPU)
 *  - se a leitura falhar por 2 ticks consecutivos -> todas as fans a 100%
 *  - encerramento (Ctrl+C/SIGTERM) restaura o modo automático do BMC
 *
 * Uso: node controller.js
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP_DIR = __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const IPMI_DIR = config.ipmi.dir;
const IPMI_EXE = path.join(IPMI_DIR, 'IPMICFG-Win.exe');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const LOG_DIR = path.join(APP_DIR, config.log.dir || 'logs');
const LOG_FILE = path.join(LOG_DIR, config.log.file || 'fan_controller.log');
const SERVER_HOST = (config.server && config.server.host) || '127.0.0.1';
const SERVER_PORT = (config.server && config.server.port) || 3041;
const BMC = config.bmc || {};

// Nomes físicos (silkscreen da placa) por slot — configuráveis via config.json.
// Obs.: a BMC nomeia os slots de forma diferente; usamos BMC_NAMES (nomes que a
// BMC retorna no getallsensors) só para casar a leitura de RPM e rotulamos com o
// nome físico (FAN_NAMES) no controle/UI.
const BMC_NAMES = ['CPU_FAN1','CPU_FAN2','REAR_FAN1','REAR_FAN2','FRNT_FAN1','FRNT_FAN2','FRNT_FAN3','FRNT_FAN4'];
const FAN_NAMES = (config.fanNames && Array.isArray(config.fanNames) && config.fanNames.length === 8)
  ? config.fanNames
  : ['CPU_FAN1','REAR_FAN1','REAR_FAN2','FRNT_FAN1','FRNT_FAN2','FRNT_FAN3','FRNT_FAN4','CPU_FAN2'];
const FAN_SLOTS = 7; // controláveis via -raw 0x3a (a 8ª fan, CPU_FAN2, fica em auto da BMC)
const GLOBAL_MIN = (config.behavior && config.behavior.globalMin) || 20;
const TEST_DURATION_MS = ((config.behavior && config.behavior.testDurationSec) || 10) * 1000;
let sensorIntervalSec = (config.sensor && config.sensor.interval) || 2;

let IPMI_PREFIX = [];
let curves = config.curves || { cpu: {}, gpu: {} };
let fanMapping = config.fanMapping || {};

let latestSensors = { ok: false, temps: {}, fans: [], volts: {}, all: [], gpu: null };
let latestDuties = [];
let latestMode = null;
let lastError = null;
let lastTargets = null;
let testOverride = {}; // slot -> timestamp fim (ms)
let stopping = false;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

/* ---------------- IPMI helpers ---------------- */

let ipmiChain = Promise.resolve();
function runIpmi(args, timeoutMs = 8000) {
  const task = () => new Promise((resolve) => {
    let child;
    try { child = spawn(IPMI_EXE, args, { cwd: IPMI_DIR, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out, err }); });
  });
  const result = ipmiChain.then(task, task);
  ipmiChain = result.catch(() => {});
  return result;
}

function runCmd(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}

async function getGpuTemp() {
  const candidates = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe',
                      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
  for (const c of candidates) {
    const r = await runCmd(c, ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']);
    const m = r.out.match(/\d+/);
    if (m) { const t = parseInt(m[0], 10); if (t >= 0 && t <= 200) return t; }
  }
  return null;
}

async function readFanStatus() {
  const r = await runIpmi([...IPMI_PREFIX, '-raw', '0x3a', '0x02']);
  const txt = (r.out + ' ' + r.err).trim();
  const bytes = txt.match(/[0-9a-fA-F]{2}/g) || [];
  return { valid: bytes.length > 0, mode: bytes[0] ? bytes[0].toUpperCase() : null, duties: bytes.slice(1).map(b => b.toUpperCase()), raw: txt };
}

/* ---------------- Leitura rápida via HTTP da web BMC (Megarac SP) ----------------
 * A interface web da BMC lê todos os sensores em ~100-300ms via:
 *   POST /rpc/WEBSES/create.asp  (WEBVAR_USERNAME/WEBVAR_PASSWORD) -> SESSION_COOKIE
 *   GET  /rpc/getallsensors.asp  (Cookie: SessionCookie=...)        -> dados dos 32 sensores
 * Modo de leitura ÚNICO (sem fallback p/ -sdr in-band, que leva 6-9s).
 * Valor real = SensorReading / 1000. Unidades (SensorUnit2, spec IPMI): 1=C, 4=V, 18=RPM, 24=%.
 */
let bmcSessionCookie = null;
let bmcLoginBusy = null;            // mutex: evita logins concorrentes
let lastLoginAt = 0;                // timestamp da última tentativa de login
let lastLoginOk = false;            // se o último login foi bem-sucedido
const LOGIN_MIN_INTERVAL_MS = 5000; // throttle p/ não martelar a BMC quando ela estiver fora

function bmcHttp(method, path, body, timeout = 6000) {
  return new Promise((resolve) => {
    const headers = { Referer: 'http://' + (BMC.address || '') + '/page/sensor_readings.html' };
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (bmcSessionCookie) headers['Cookie'] = 'SessionCookie=' + bmcSessionCookie;
    const r = http.request({ host: BMC.address || '', port: 80, path, method, headers, timeout }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, body: '' }); });
    r.on('error', e => resolve({ status: -1, body: String(e) }));
    if (body) r.write(body);
    r.end();
  });
}

// Login na web BMC. Com throttle: se o último login FALHOU há pouco, não tenta de novo
// (evita martelar a BMC quando está fora); após sucesso, retenta livremente p/ renovar sessão.
async function bmcLogin() {
  if (bmcLoginBusy) return bmcLoginBusy; // reaproveita login em andamento (chamadas concorrentes)
  const now = Date.now();
  if (now - lastLoginAt < LOGIN_MIN_INTERVAL_MS && !lastLoginOk) return false; // throttle pós-falha
  lastLoginAt = now;
  bmcLoginBusy = (async () => {
    try {
      const r = await bmcHttp('POST', '/rpc/WEBSES/create.asp',
        'WEBVAR_USERNAME=' + encodeURIComponent(BMC.user || '') + '&WEBVAR_PASSWORD=' + encodeURIComponent(BMC.password || ''));
      const m = r.body.match(/SESSION_COOKIE'\s*:\s*'([^']+)'/);
      if (m && r.status === 200) {
        bmcSessionCookie = m[1];
        lastLoginOk = true;
        log('BMC: sessão HTTP renovada (' + m[1].slice(0, 6) + '…)');
        return true;
      }
      bmcSessionCookie = null;
      lastLoginOk = false;
      log('BMC: login HTTP falhou (status ' + r.status + ')');
      return false;
    } catch (e) {
      bmcSessionCookie = null;
      lastLoginOk = false;
      return false;
    } finally { bmcLoginBusy = null; }
  })();
  return bmcLoginBusy;
}

// Resposta de getallsensors.asp traz os sensores -> indica sessão válida
function hasSensorData(body) {
  return /WEBVAR_JSONVAR_HL_GETALLSENSORS/i.test(body) && /\{\s*'SensorNumber'/.test(body);
}

function parseGetAllSensors(body) {
  const out = { temps: {}, fans: [], volts: {}, all: [] };
  const tempMap = { 'MB Temperature': 'mb', 'CPU_BSP1 Temp': 'cpu_bsp1', 'CPU_AP1 Temp': 'cpu_ap1' }; // sem TR1 (não temos nesta build)
  const unitStr = { 1: 'C', 2: 'F', 3: 'K', 4: 'V', 5: 'A', 6: 'W', 18: 'RPM', 24: '%' };
  const reBlock = /\{\s*'SensorNumber'\s*:\s*(\d+),'SensorName'\s*:\s*'([^']+)'([\s\S]*?)\}/g;
  let m;
  while ((m = reBlock.exec(body))) {
    const id = parseInt(m[1], 10);
    const name = m[2].trim();
    if (name === 'TR1 Temperature') continue; // TR1 removido (não existe nesta build)
    const rest = m[3];
    const gR = rest.match(/'SensorReading'\s*:\s*(\d+)/);
    const gS = rest.match(/'SensorState'\s*:\s*(\d+)/);
    const gU = rest.match(/'SensorUnit2'\s*:\s*(\d+)/);
    const real = gR ? parseInt(gR[1], 10) / 1000 : null;
    const state = gS ? parseInt(gS[1], 10) : 0;
    const unit = gU ? parseInt(gU[1], 10) : 0;
    const us = unitStr[unit] || '';
    out.all.push({
      id, name,
      status: state === 1 ? 'ok' : (state ? 'ns' : 'NA'),
      value: real == null ? 'N/A' : (unit === 4 || unit === 5 ? real.toFixed(3) : String(Math.round(real))) + (us ? ' ' + us : ''),
      low: '', high: ''
    });
    if (tempMap[name] != null && unit === 1 && real != null) out.temps[tempMap[name]] = Math.round(real);
    const fanIdx = BMC_NAMES.indexOf(name);
    if (fanIdx >= 0 && unit === 18) {
      out.fans[fanIdx] = { position: fanIdx + 1, name: FAN_NAMES[fanIdx], sdrId: 17 + fanIdx, rpm: real != null && real > 0 ? Math.round(real) : null, detected: real != null && real > 0, writable: fanIdx < FAN_SLOTS };
    }
    if ((unit === 4 || unit === 5) && real != null) out.volts[name] = Math.round(real * 1000) / 1000;
  }
  for (let i = 0; i < FAN_NAMES.length; i++) {
    if (!out.fans[i]) out.fans[i] = { position: i + 1, name: FAN_NAMES[i], sdrId: 17 + i, rpm: null, detected: false, writable: i < FAN_SLOTS };
  }
  return out;
}

async function readSensorsFast() {
  const out = { ok: true, gpu: null, temps: {}, fans: [], volts: {}, all: [], reason: null };
  if (!BMC.address) { out.ok = false; out.reason = 'sem endereço BMC configurado'; return out; }
  // Garante sessão (login inicial ou renovação após expirar/limpar)
  if (!bmcSessionCookie && !(await bmcLogin())) { out.ok = false; out.reason = 'login HTTP da BMC falhou'; return out; }
  let r = await bmcHttp('GET', '/rpc/getallsensors.asp');
  // Sessão expirada? (status != 200 OU resposta sem os sensores) -> re-login 1x e relê
  if (r.status !== 200 || !hasSensorData(r.body)) {
    bmcSessionCookie = null;
    if (await bmcLogin()) r = await bmcHttp('GET', '/rpc/getallsensors.asp');
  }
  if (r.status !== 200 || !hasSensorData(r.body)) {
    out.ok = false;
    out.reason = 'getallsensors HTTP status ' + r.status + (hasSensorData(r.body) ? '' : ' (resposta sem sensores)');
    return out;
  }
  const p = parseGetAllSensors(r.body);
  if (!p.all.length) { out.ok = false; out.reason = 'getallsensors sem dados'; return out; }
  lastLoginOk = true; // leitura com sessão válida
  out.temps = p.temps; out.fans = p.fans; out.volts = p.volts; out.all = p.all;
  out.gpu = await getGpuTemp();
  return out;
}

function dutyHex(p) { const v = Math.max(0, Math.min(100, Math.round(p))); return '0x' + v.toString(16).padStart(2, '0'); }

async function setFans(duties7) {
  const args = ['-raw', '0x3a', '0x01', '0x00', ...duties7.map(d => dutyHex(d))];
  return runIpmi(args);
}
async function setAuto() {
  return runIpmi(['-raw', '0x3a', '0x01', '0x01', '0x00', '0x00', '0x00', '0x00', '0x00', '0x00', '0x00']);
}

/* ---------------- Modo de coleta (LAN ou in-band) ---------------- */

async function detectMode() {
  const a = BMC.address ? String(BMC.address).trim() : '';
  if (!a) { log('BMC: coleta in-band (local)'); return []; }
  const u = BMC.user || 'admin', p = BMC.password || 'admin';
  try {
    const r = await runIpmi(['-m', a, '-u', u, '-p', p, '-sdr'], 8000);
    if (r.code === 0 && /FAN|Sensor|RPM/i.test(r.out)) { log('BMC: coleta via LAN (' + a + ')'); return ['-m', a, '-u', u, '-p', p]; }
  } catch (_) {}
  log('BMC: LAN indisponível para ' + a + ' — usando in-band (local)');
  return [];
}

/* ---------------- Controle (mapping + curvas) ---------------- */

function sensorVal(sensor) { return sensor === 'gpu' ? latestSensors.gpu : latestSensors.temps[sensor]; }

function curvePct(curve, temp) {
  if (temp == null) return null;
  const pts = Object.entries(curves[curve] || {}).map(([t, p]) => [parseInt(t, 10), p]).sort((a, b) => a[0] - b[0]);
  let pct = GLOBAL_MIN;
  for (const [t, p] of pts) if (temp >= t) pct = p;
  return Math.max(GLOBAL_MIN, pct);
}

function computeDuties() {
  const duties = new Array(FAN_SLOTS).fill(GLOBAL_MIN);
  for (let s = 1; s <= FAN_SLOTS; s++) {
    const m = fanMapping[s] || { sensor: 'mb', curve: 'cpu' };
    const val = sensorVal(m.sensor);
    let pct = curvePct(m.curve, val);
    if (pct == null) pct = 100; // sensor indisponível -> alto (seguro)
    duties[s - 1] = pct;
  }
  const now = Date.now();
  for (const [slot, end] of Object.entries(testOverride)) {
    if (now < end) duties[Number(slot) - 1] = 100;
    else delete testOverride[slot];
  }
  return duties;
}

let controlBusy = false;
let failCount = 0; // falhas consecutivas de leitura (p/ evitar FALLBACK em falha transiente)

async function readSensorsWithRetry() {
  // Modo de leitura único (HTTP ~100-300ms), sem fallback.
  let last = null;
  for (let i = 0; i < 3; i++) {
    last = await readSensorsFast();
    if (last.ok) return last;
    await new Promise(r => setTimeout(r, 200));
  }
  return last;
}

async function controlTick() {
  if (controlBusy || stopping) return;
  controlBusy = true;
  try {
    const s = await readSensorsWithRetry();
    latestSensors = s;
    if (!s.ok) {
      failCount++;
      if (failCount >= 2) {
        await setFans(new Array(FAN_SLOTS).fill(100)); // fallback: falhas consecutivas -> todas 100%
        latestMode = '00';
        latestDuties = new Array(FAN_SLOTS).fill('64');
        lastError = 'BMC sem comunicação — fans a 100%';
        log('FALLBACK (falha ' + failCount + 'x): BMC sem comunicação — fans a 100% | ' + (s.reason || ''));
      } else {
        lastError = 'leitura instável (falha ' + failCount + '/2) — mantendo duties atuais';
        log('leitura instável (' + (s.reason || '') + ') — mantendo fans, sem FALLBACK');
      }
      return;
    }
    failCount = 0;
    lastError = null;
    const duties = computeDuties();
    if (!lastTargets || duties.some((d, i) => d !== lastTargets[i])) {
      lastTargets = duties.slice();
      const r = await setFans(duties);
      if (r.code !== 0) { lastError = 'set falhou: ' + (r.err || r.out).trim(); log('set falhou: ' + lastError); return; }
      const st = await readFanStatus();
      latestMode = st.mode; latestDuties = st.duties;
      log('fans: ' + duties.map((d, i) => FAN_NAMES[i] + '=' + d + '%').join(' '));
    } else {
      const st = await readFanStatus();
      latestMode = st.mode; latestDuties = st.duties;
    }
  } catch (e) {
    lastError = String(e && e.message || e);
    log('erro controlTick: ' + lastError);
  } finally { controlBusy = false; }
}

let controlTimer = null;
function startControl() { controlTick(); controlTimer = setInterval(controlTick, sensorIntervalSec * 1000); }
function restartControl() { if (controlTimer) clearInterval(controlTimer); startControl(); }

async function testFan(slot) {
  const s = parseInt(slot, 10);
  if (s < 1 || s > FAN_SLOTS) return { ok: false, error: 'slot inválido (1-' + FAN_SLOTS + ')' };
  testOverride[s] = Date.now() + TEST_DURATION_MS;
  controlTick();
  return { ok: true, slot: s, seconds: TEST_DURATION_MS / 1000 };
}
function testStop() { testOverride = {}; lastTargets = null; controlTick(); return { ok: true }; }

/* ---------------- Servidor HTTP ---------------- */

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

    if (u.pathname === '/api/state') {
      send({ ts: Date.now(), sensors: latestSensors, mode: latestMode, duties: latestDuties, error: lastError, curves, fanMapping, fanNames: FAN_NAMES, fanSlots: FAN_NAMES.length, writableSlots: FAN_SLOTS, testOverride });
      return;
    }
    if (u.pathname === '/api/config' && req.method === 'GET') {
      send({ bmc: { address: BMC.address || '', user: BMC.user || '', password: BMC.password ? '***' : '' }, sensor: { interval: sensorIntervalSec }, curves, fanMapping, fanNames: FAN_NAMES, writableSlots: FAN_SLOTS, mode: IPMI_PREFIX.length ? 'lan' : 'inband' });
      return;
    }
    if (u.pathname === '/api/config' && req.method === 'PUT') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const nc = JSON.parse(body || '{}');
          if (nc.bmc) {
            if (nc.bmc.address !== undefined) BMC.address = String(nc.bmc.address).trim();
            if (nc.bmc.user !== undefined) BMC.user = String(nc.bmc.user);
            if (nc.bmc.password && nc.bmc.password !== '***') BMC.password = String(nc.bmc.password);
            bmcSessionCookie = null; // credenciais/endereço mudaram -> descarta sessão antiga
          }
          if (nc.sensor && nc.sensor.interval !== undefined) sensorIntervalSec = Math.max(1, Math.min(60, parseInt(nc.sensor.interval, 10) || 2));
          if (nc.curves) {
            const clean = {};
            for (const name of ['cpu', 'gpu']) {
              if (nc.curves[name] && typeof nc.curves[name] === 'object') {
                clean[name] = {};
                for (const [t, p] of Object.entries(nc.curves[name])) {
                  const tt = parseInt(t, 10), pp = Math.max(0, Math.min(100, parseInt(p, 10) || 0));
                  if (!isNaN(tt)) clean[name][tt] = pp;
                }
              }
            }
            curves = clean;
          }
          if (nc.fanMapping && typeof nc.fanMapping === 'object') {
            const validSensors = ['gpu', 'cpu_bsp1', 'cpu_ap1', 'mb'];
            const cleanMap = {};
            for (let s = 1; s <= FAN_SLOTS; s++) {
              const m = nc.fanMapping[s];
              if (m && validSensors.includes(m.sensor) && (m.curve === 'cpu' || m.curve === 'gpu')) cleanMap[s] = { sensor: m.sensor, curve: m.curve };
            }
            fanMapping = cleanMap;
          }
          config.bmc = { address: BMC.address, user: BMC.user, password: BMC.password };
          config.sensor = config.sensor || {}; config.sensor.interval = sensorIntervalSec;
          config.curves = curves; config.fanMapping = fanMapping;
          try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('config nao salvo:', e.message); }
          detectMode().then(prefix => { IPMI_PREFIX = prefix; });
          restartControl();
          send({ ok: true });
        } catch (e) { send({ ok: false, error: String(e && e.message || e) }, 400); }
      });
      return;
    }
    if (u.pathname === '/api/test') {
      (async () => {
        let s = null;
        for (let i = 0; i < 3; i++) { s = await readSensorsFast(); if (s && s.ok) break; await new Promise(r => setTimeout(r, 400)); }
        send({ ok: !!(s && s.ok), gpu: s && s.gpu, cpu: s && s.temps ? Math.max(s.temps.cpu_bsp1 || 0, s.temps.cpu_ap1 || 0) : null, cpu_bsp1: s && s.temps && s.temps.cpu_bsp1, cpu_ap1: s && s.temps && s.temps.cpu_ap1, mb: s && s.temps && s.temps.mb, mode: 'http' });
      })().catch(e => send({ ok: false, error: String(e && e.message || e) }));
      return;
    }
    const mTest = u.pathname.match(/^\/api\/fan\/(\d+)\/test$/);
    if (mTest && req.method === 'POST') { testFan(mTest[1]).then(r => send(r)); return; }
    if (u.pathname === '/api/fan/teststop' && req.method === 'POST') { send(testStop()); return; }

    // estáticos
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  server.on('error', e => console.error('Web server erro:', e.message));
  server.listen(SERVER_PORT, SERVER_HOST, () => log('Web UI: http://' + SERVER_HOST + ':' + SERVER_PORT));
}

/* ---------------- Shutdown ---------------- */

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('=== Encerrando — restaurando modo automático ===');
  try { await setAuto(); } catch (_) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------------- Main ---------------- */

detectMode().then(prefix => { IPMI_PREFIX = prefix; startControl(); startServer(); });
