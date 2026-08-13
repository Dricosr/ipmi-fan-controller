'use strict';
const $ = (s) => document.querySelector(s);
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

function pctNum(hex) { return hex ? parseInt(hex, 16) : 0; }

// Legenda dos sensores (tooltip) — descrição do que cada um mede
const SENSOR_INFO = {
  'ATX+5VSB': 'Standby 5V da fonte (alimenta o BMC mesmo desligado)',
  '+3VSB': 'Standby 3,3V da fonte',
  'Vcore1': 'Tensão do núcleo do CPU socket 1 (VRM da CPU)',
  'Vcore2': 'Tensão do núcleo do CPU socket 2 (VRM da CPU)',
  'VCCM A/B': 'Tensão da memória DDR3 — grupo A/B (VRM de memória)',
  'VCCM C/D': 'Tensão da memória DDR3 — grupo C/D',
  'VCCM E/F': 'Tensão da memória DDR3 — grupo E/F',
  'VCCM G/H': 'Tensão da memória DDR3 — grupo G/H',
  '+1.10_PCH': 'Rail 1,1V do chipset PCH (Intel C602/Patsburg)',
  '+1.50_PCH': 'Rail 1,5V do chipset PCH',
  'BAT': 'Bateria CMOS (relógio e configurações)',
  '+3V': 'Rail principal 3,3V da fonte',
  '+5V': 'Rail principal 5V da fonte',
  '+12V': 'Rail principal 12V da fonte',
  'MB Temperature': 'Temperatura da placa-mãe (sensor onboard)',
  'CPU_BSP1 Temp': 'Temperatura do CPU socket 1 (BSP = processador de boot)',
  'CPU_AP1 Temp': 'Temperatura do CPU socket 2 (AP = processador de aplicação)',
  'SATAIII_0': 'Porta SATA3 6Gb/s #0 (PCH C602) — presença de drive',
  'SATAIII_1': 'Porta SATA3 6Gb/s #1 (PCH C602) — presença de drive',
  'SCU_PORT_0': 'Porta SCU 0 (Storage Control Unit do C602) — presença de drive',
  'SCU_PORT_1': 'Porta SCU 1 (Storage Control Unit do C602) — presença de drive',
  'SCU_PORT_2': 'Porta SCU 2 (Storage Control Unit do C602) — presença de drive',
  'SCU_PORT_3': 'Porta SCU 3 (Storage Control Unit do C602) — presença de drive'
};

async function load() {
  try {
    const r = await fetch('/api/state');
    const d = await r.json();
    render(d);
  } catch (e) {
    $('#status').innerHTML = '<span class="dot red"></span> servidor indisponível';
  }
}

function render(d) {
  const s = d.sensors;
  const ok = !!s && s.ok;
  $('#status').innerHTML = `<span class="dot ${ok ? 'green' : 'red'}"></span> ${ok ? 'BMC OK' : (d.error || 'BMC SEM COMUNICAÇÃO')}`;
  $('#ts').textContent = 'atualizado ' + new Date(d.ts).toLocaleTimeString();

  // Temperaturas (cards)
  const temps = $('#temps');
  temps.innerHTML = '';
  const tempDefs = [['gpu', 'GPU'], ['cpu_bsp1', 'CPU BSP1'], ['cpu_ap1', 'CPU AP1'], ['mb', 'Placa-Mãe']];
  for (const [key, label] of tempDefs) {
    const val = key === 'gpu' ? (s && s.gpu) : (s && s.temps[key]);
    const c = el('div', 'card temp');
    const att = attachedInfo(d, key);
    let sub = 'fan atrelada: —';
    let title = '';
    if (att && att.length === 1) sub = `fan atrelada: ${att[0].pct}% (${att[0].name})`;
    else if (att && att.length > 1) {
      sub = `fans atreladas (${att.length}): ${att.map(a => a.pct).join('/')}%`;
      title = ` title="${att.map(a => `${a.name} ${a.pct}%`).join(' · ')}"`;
    }
    c.innerHTML = `<h3>${label}</h3><div class="big">${val == null ? '—' : val + '°C'}</div>
      <div class="sub"${title}>${sub}</div>`;
    temps.appendChild(c);
  }

  // Fans
  const tb = $('#fans tbody');
  tb.innerHTML = '';
  const duties = d.duties || [];
  if (s && s.fans) {
    s.fans.forEach((f, i) => {
      const tr = el('tr');
      const duty = duties[i];
      const pct = duty == null ? null : pctNum(duty);
      const dutyCell = f.writable === false
        ? `<td class="dim">auto (BMC)</td>`
        : `<td><div class="bar"><i style="width:${pct || 0}%"></i></div><span>${pct == null ? '—' : pct + '%'}</span></td>`;
      tr.innerHTML = `<td>${f.position}</td><td>${f.name}</td><td>${f.rpm ?? 'N/A'}</td>${dutyCell}`;
      tb.appendChild(tr);
    });
  }

  // Voltagens
  const v = $('#volts');
  v.innerHTML = '';
  if (s && s.volts) {
    Object.entries(s.volts).forEach(([k, val]) => {
      const chip = el('span', 'chip', `${k} ${val}V`);
      if (SENSOR_INFO[k]) chip.title = SENSOR_INFO[k];
      v.appendChild(chip);
    });
  }

  // Sensores (todos)
  const as = $('#allSensors tbody');
  as.innerHTML = '';
  if (s && s.all && s.all.length) {
    s.all.forEach((x) => {
      const tr = el('tr');
      const st = String(x.status || '').toLowerCase();
      const cls = st === 'ok' ? 'ok' : (st === '' || st === 'na' || x.value === 'N/A') ? 'na' : 'warn';
      const ttl = /FAN/i.test(x.name)
        ? 'RPM — o nome físico de cada fan está na tabela "Fans" acima'
        : (SENSOR_INFO[x.name] || '');
      const tAttr = ttl ? ` title="${ttl}"` : '';
      tr.innerHTML = `<td>${x.id}</td><td${tAttr}>${x.name}</td><td class="st ${cls}">${x.status || 'NA'}</td><td>${x.value}</td><td class="dim">${x.low} / ${x.high}</td>`;
      as.appendChild(tr);
    });
  }
}

// Quais fans estão atreladas a um sensor (via fanMapping) e a duty atual de cada uma
function attachedInfo(d, sensorKey) {
  const duties = d.duties || [];
  const mapping = d.fanMapping || {};
  const names = d.fanNames || [];
  const slots = Object.keys(mapping).filter(s => mapping[s].sensor === sensorKey).map(Number).sort((a, b) => a - b);
  if (!slots.length) return null;
  return slots.map(s => ({ slot: s, name: names[s - 1] || 'slot ' + s, pct: pctNum(duties[s - 1]) }));
}

load();
setInterval(load, 1000);
