'use strict';
const $ = (s) => document.querySelector(s);
const msg = $('#msg');
const modeInfo = $('#modeInfo');

function setMsg(txt, ok) {
  msg.textContent = txt;
  msg.className = 'msg ' + (ok === false ? 'bad' : ok === true ? 'good' : '');
}

async function loadCfg() {
  try {
    const r = await fetch('/api/config');
    const d = await r.json();
    $('#bmcAddress').value = d.bmc.address || '';
    $('#bmcUser').value = d.bmc.user || '';
    $('#bmcPassword').value = d.bmc.password || '';
    $('#bmcPassword').placeholder = d.bmc.password === '***' ? '•••••• (mantida)' : '••••••';
    $('#sensorInterval').value = d.sensor.interval;
    modeInfo.textContent = 'Leitura de sensores: HTTP (web da BMC) · Controle das fans: IPMICFG in-band · ' + (d.bmc.address || 'sem endereço BMC');
    $('#status').innerHTML = '<span class="dot green"></span> config carregada';
  } catch (e) {
    setMsg('Erro ao carregar config: ' + e.message, false);
  }
}

async function save() {
  const payload = {
    bmc: {
      address: $('#bmcAddress').value.trim(),
      user: $('#bmcUser').value.trim(),
      password: $('#bmcPassword').value
    },
    sensor: { interval: parseInt($('#sensorInterval').value, 10) || 2 }
  };
  if (!payload.bmc.password) delete payload.bmc.password; // não enviar vazio = manter
  try {
    const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (d.ok) setMsg('✅ Configuração salva e aplicada.', true);
    else setMsg('❌ ' + (d.error || 'erro ao salvar'), false);
    loadCfg();
  } catch (e) {
    setMsg('Erro: ' + e.message, false);
  }
}

async function testConn() {
  setMsg('Testando comunicação…');
  $('#btnTest').disabled = true;
  try {
    const r = await fetch('/api/test');
    const d = await r.json();
    if (d.ok) {
      const gpuTxt = d.gpu != null ? d.gpu + '°C (local)' : 'N/A';
      const cpuTxt = d.cpu != null ? d.cpu + '°C (BMC)' : 'N/A';
      setMsg('✅ Comunicação OK — GPU ' + gpuTxt + ' · CPU ' + cpuTxt + ' · leitura via HTTP (web BMC)', true);
    } else {
      setMsg('❌ Falha na comunicação: ' + (d.error || 'BMC não respondeu') + ' — confira endereço/usuário/senha da BMC.', false);
    }
  } catch (e) {
    setMsg('Erro: ' + e.message, false);
  } finally {
    $('#btnTest').disabled = false;
  }
}

function setResetMsg(txt, ok) {
  $('#resetMsg').textContent = txt;
  $('#resetMsg').className = 'msg ' + (ok === false ? 'bad' : ok === true ? 'good' : '');
}

async function resetBmc() {
  const okc = confirm('Reiniciar a BMC (cold reset)?\n\nA web/sensores da BMC ficarão indisponíveis por ~2–4 minutos e as fans podem ir a 100% durante o reset. O app reconecta sozinho.');
  if (!okc) return;
  const btn = $('#btnResetBmc');
  btn.disabled = true;
  setResetMsg('Reiniciando a BMC… (aguarde, pode levar alguns segundos)');
  try {
    const r = await fetch('/api/bmc/reset', { method: 'POST' });
    const d = await r.json();
    if (d.ok) setResetMsg('✅ ' + (d.output || 'BMC reiniciando.') + ' — web/sensores fora por alguns minutos; o app reconecta sozinho.', true);
    else setResetMsg('❌ ' + (d.error || 'erro ao reiniciar a BMC'), false);
  } catch (e) {
    setResetMsg('Erro: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
}

$('#cfgForm').addEventListener('submit', (e) => { e.preventDefault(); save(); });
$('#btnTest').addEventListener('click', testConn);
$('#btnResetBmc').addEventListener('click', resetBmc);
loadCfg();
