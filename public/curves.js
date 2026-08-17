'use strict';
const $ = (s) => document.querySelector(s);
const msg = $('#msg');
const KEYS = { cpu: { chart: 'chartCpu', rows: 'rowsCpu', add: 'addCpu' }, gpu: { chart: 'chartGpu', rows: 'rowsGpu', add: 'addGpu' }, mobo: { chart: 'chartMobo', rows: 'rowsMobo', add: 'addMobo' } };

function setMsg(txt, ok) { msg.textContent = txt; msg.className = 'msg ' + (ok === false ? 'bad' : ok === true ? 'good' : ''); }

// --- Rows helpers ---
function rowsFor(key) {
  const tbody = document.getElementById(KEYS[key].rows);
  const rows = [];
  tbody.querySelectorAll('tr').forEach(tr => {
    const t = parseInt(tr.querySelector('.t').value, 10);
    const p = parseInt(tr.querySelector('.p').value, 10);
    if (!isNaN(t) && !isNaN(p)) rows.push({ temp: t, pct: Math.max(0, Math.min(100, p)) });
  });
  return rows.sort((a, b) => a.temp - b.temp);
}

function addRow(key, temp, pct) {
  const tbody = document.getElementById(KEYS[key].rows);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" class="t" min="0" max="120" step="1" value="${temp == null ? '' : temp}"></td>
    <td><input type="number" class="p" min="0" max="100" step="5" value="${pct == null ? '' : pct}"></td>
    <td><button type="button" class="del">✕</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('.del').addEventListener('click', () => { tr.remove(); renderChart(key); });
  tr.querySelector('.t').addEventListener('input', () => renderChart(key));
  tr.querySelector('.p').addEventListener('input', () => renderChart(key));
}

function renderRows(key, curve) {
  const tbody = document.getElementById(KEYS[key].rows);
  tbody.innerHTML = '';
  const pts = curve ? Object.entries(curve).map(([t, p]) => ({ temp: parseInt(t, 10), pct: p })).sort((a, b) => a.temp - b.temp) : [];
  if (!pts.length) addRow(key, 40, 50);
  pts.forEach(pt => addRow(key, pt.temp, pt.pct));
  renderChart(key);
}

// --- Chart (SVG polyline) ---
function renderChart(key) {
  const pts = rowsFor(key);
  const svg = document.getElementById(KEYS[key].chart);
  const W = 320, H = 170, pad = 22;
  const xMax = Math.max(100, ...pts.map(p => p.temp), 1);
  const px = (t) => pad + (t / xMax) * (W - 2 * pad);
  const py = (p) => H - pad - (p / 100) * (H - 2 * pad);
  const line = pts.length >= 2
    ? `<polyline points="${pts.map(p => px(p.temp).toFixed(1) + ',' + py(p.pct).toFixed(1)).join(' ')}" class="cline" fill="none"/>`
    : '';
  const circles = pts.map(p => `<circle cx="${px(p.temp).toFixed(1)}" cy="${py(p.pct).toFixed(1)}" r="3.5" class="cpt"/>`).join('');
  const labels = pts.map(p => `<text x="${px(p.temp).toFixed(1) + 4}" y="${(py(p.pct) - 5).toFixed(1)}" class="clbl">${p.temp}° → ${p.pct}%</text>`).join('');
  svg.innerHTML = `
    <line x1="${pad}" y1="${py(0)}" x2="${W - pad}" y2="${py(0)}" class="cax"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" class="cax"/>
    <text x="4" y="${py(100) + 4}" class="ctick">100%</text>
    <text x="4" y="${py(0) - 3}" class="ctick">0%</text>
    <text x="${W - 34}" y="${H - 6}" class="ctick">${xMax}°C</text>
    ${line}${circles}${labels}`;
}

// --- Load / Save ---
async function load() {
  try {
    const r = await fetch('/api/config');
    const d = await r.json();
    const curves = d.curves || {};
    renderRows('cpu', curves.cpu);
    renderRows('gpu', curves.gpu);
    renderRows('mobo', curves.mobo);
    $('#status').innerHTML = '<span class="dot green"></span> curvas carregadas';
  } catch (e) { setMsg('Erro ao carregar curvas: ' + e.message, false); }
}

async function save() {
  const curves = { cpu: {}, gpu: {}, mobo: {} };
  for (const key of ['cpu', 'gpu', 'mobo']) {
    rowsFor(key).forEach(p => { curves[key][p.temp] = p.pct; });
  }
  try {
    const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ curves }) });
    const d = await r.json();
    setMsg(d.ok ? '✅ Curvas salvas.' : '❌ ' + (d.error || 'erro'), d.ok);
  } catch (e) { setMsg('Erro: ' + e.message, false); }
}

$('#addCpu').addEventListener('click', () => { addRow('cpu'); renderChart('cpu'); });
$('#addGpu').addEventListener('click', () => { addRow('gpu'); renderChart('gpu'); });
$('#addMobo').addEventListener('click', () => { addRow('mobo'); renderChart('mobo'); });
$('#btnSave').addEventListener('click', save);
load();
