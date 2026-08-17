'use strict';
const $ = (s) => document.querySelector(s);
const msg = $('#msg');
const FAN_NAMES = ['CPU_FAN1','REAR_FAN1','REAR_FAN2','FRNT_FAN1','FRNT_FAN2','FRNT_FAN3','FRNT_FAN4','CPU_FAN2'];
const WRITABLE = 7; // slots 1-7 controláveis; slot 8 (CPU_FAN2) = BMC auto
const SENSOR_LABELS = { gpu: 'GPU (local)', cpu_bsp1: 'CPU BSP1 (BMC)', cpu_ap1: 'CPU AP1 (BMC)', mb: 'MB (BMC)' };

let mapping = {};
let curves = { cpu: {}, gpu: {}, mobo: {} };
let live = { gpu: null, temps: {} };

function setMsg(txt, ok) { msg.textContent = txt; msg.className = 'msg ' + (ok === false ? 'bad' : ok === true ? 'good' : ''); }

function sensorVal(sensor) { return sensor === 'gpu' ? live.gpu : (live.temps[sensor] != null ? live.temps[sensor] : null); }

function curvePct(curve, temp) {
  if (temp == null) return null;
  const pts = Object.entries(curves[curve] || {}).map(([t, p]) => [parseInt(t, 10), p]).sort((a, b) => a[0] - b[0]);
  let pct = 20; // piso (globalMin) — igual ao controller
  for (const [t, p] of pts) if (temp >= t) pct = p;
  return Math.max(20, pct);
}

function updateRow(tr, slot) {
  const sensor = tr.querySelector('.sensor').value;
  const curve = tr.querySelector('.curve').value;
  const val = sensorVal(sensor);
  const pct = curvePct(curve, val);
  tr.querySelector('.val').textContent = val != null ? val + '°C' : '—';
  tr.querySelector('.pct').textContent = pct != null ? pct + '%' : '—';
}

function buildRows() {
  const tb = $('#mapTable tbody');
  tb.innerHTML = '';
  for (let s = 1; s <= 8; s++) {
    const tr = document.createElement('tr');
    if (s > WRITABLE) {
      // slot 8 = CPU_FAN2: não controlável via IPMI (fica em auto da BMC)
      tr.innerHTML = `<td>${s}</td><td>${FAN_NAMES[s - 1]}</td>
        <td colspan="5" class="dim">⚠ não controlável via IPMI — a BMC mantém em automático</td>`;
      tb.appendChild(tr);
      continue;
    }
    const m = mapping[s] || { sensor: 'mb', curve: 'cpu' };
    const sensorSelect = Object.keys(SENSOR_LABELS).map(k => `<option value="${k}" ${k === m.sensor ? 'selected' : ''}>${SENSOR_LABELS[k]}</option>`).join('');
    const curveSelect = `<option value="cpu" ${m.curve === 'cpu' ? 'selected' : ''}>CPU</option><option value="gpu" ${m.curve === 'gpu' ? 'selected' : ''}>GPU</option><option value="mobo" ${m.curve === 'mobo' ? 'selected' : ''}>MOBO</option>`;
    tr.innerHTML = `<td>${s}</td><td>${FAN_NAMES[s - 1]}</td>
      <td><select class="sensor">${sensorSelect}</select></td>
      <td><select class="curve">${curveSelect}</select></td>
      <td class="val">—</td><td class="pct">—</td>
      <td><button type="button" class="testbtn">Test</button></td>`;
    tb.appendChild(tr);
    tr.querySelector('.sensor').addEventListener('change', () => updateRow(tr, s));
    tr.querySelector('.curve').addEventListener('change', () => updateRow(tr, s));
    tr.querySelector('.testbtn').addEventListener('click', () => testFan(s, tr.querySelector('.testbtn')));
    updateRow(tr, s);
  }
}

function refreshLive() {
  document.querySelectorAll('#mapTable tbody tr').forEach((tr, i) => updateRow(tr, i + 1));
}

async function load() {
  try {
    const [c, st] = await Promise.all([
      (await fetch('/api/config')).json(),
      (await fetch('/api/state')).json()
    ]);
    mapping = c.fanMapping || {};
    curves = c.curves || { cpu: {}, gpu: {}, mobo: {} };
    live.gpu = st.sensors.gpu;
    live.temps = st.sensors.temps || {};
    buildRows();
    $('#status').innerHTML = '<span class="dot green"></span> mapeamento carregado';
  } catch (e) { setMsg('Erro ao carregar: ' + e.message, false); }
}

async function save() {
  const fm = {};
  document.querySelectorAll('#mapTable tbody tr').forEach((tr, i) => {
    if (!tr.querySelector('.sensor')) return; // slot não controlável
    fm[i + 1] = { sensor: tr.querySelector('.sensor').value, curve: tr.querySelector('.curve').value };
  });
  try {
    const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fanMapping: fm }) });
    const d = await r.json();
    setMsg(d.ok ? '✅ Mapeamento salvo.' : '❌ ' + (d.error || 'erro'), d.ok);
  } catch (e) { setMsg('Erro: ' + e.message, false); }
}

async function testFan(slot, btn) {
  btn.disabled = true;
  btn.textContent = 'Testando…';
  try {
    const r = await fetch('/api/fan/' + slot + '/test', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      btn.textContent = '100% (' + d.seconds + 's)';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Test'; }, d.seconds * 1000 + 500);
    } else {
      btn.textContent = 'Erro';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Test'; }, 2000);
    }
  } catch (e) {
    btn.textContent = 'Erro';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Test'; }, 2000);
  }
}

$('#btnSave').addEventListener('click', save);
load();
setInterval(async () => {
  try {
    const st = await (await fetch('/api/state')).json();
    live.gpu = st.sensors.gpu;
    live.temps = st.sensors.temps || {};
    refreshLive();
  } catch (_) {}
}, 3000);
