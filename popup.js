// SuperPipeWhat popup: muestra estado de ambas integraciones + banner contextual según dominio activo.

function setRow(dotId, valId, state, text) {
  const dot = document.getElementById(dotId);
  const val = document.getElementById(valId);
  dot.className = 'dot ' + (state === 'ok' ? 'dot-ok' : state === 'warn' ? 'dot-warn' : state === 'err' ? 'dot-err' : 'dot-loading');
  val.className = 'status-value ' + (state === 'ok' ? 'good' : state === 'err' ? 'bad' : '');
  val.textContent = text;
}

async function refreshAll() {
  setRow('dotWaToken', 'valWaToken', 'loading', 'Verificando...');
  setRow('dotConnections', 'valConnections', 'loading', '—');
  setRow('dotDefault', 'valDefault', 'loading', '—');

  // Banner contextual según tab activa
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url || '';
  const onPipedrive = /https:\/\/[^/]*pipedrive\.com\//.test(url);
  const onWhaticket = /https:\/\/[^/]*whaticket\.com\//.test(url);
  const banner = document.getElementById('ctxBanner');
  if (onPipedrive) {
    banner.textContent = '✓ Estás en Pipedrive — Alt+Shift+W para enviar Whaticket';
    banner.className = 'context-banner';
    banner.style.display = 'block';
  } else if (onWhaticket) {
    banner.textContent = '✓ Estás en Whaticket — Alt+Shift+P para el panel de Pipedrive';
    banner.className = 'context-banner';
    banner.style.display = 'block';
  } else {
    banner.textContent = 'Abrí Pipedrive o Whaticket para usar los atajos.';
    banner.className = 'context-banner neutral';
    banner.style.display = 'block';
  }

  const resp = await chrome.runtime.sendMessage({ action: 'getSettings' });
  const s = (resp && resp.settings) || {};

  // Pipedrive card
  if (s.pipedriveApiToken) setRow('dotPdToken', 'valPdToken', 'ok', 'configurado');
  else setRow('dotPdToken', 'valPdToken', 'err', 'falta');

  if (s.pipedriveCompany) setRow('dotPdCompany', 'valPdCompany', 'ok', s.pipedriveCompany);
  else setRow('dotPdCompany', 'valPdCompany', 'err', 'falta');

  if (s.defaultCountryCode) setRow('dotCountry', 'valCountry', 'ok', '+' + s.defaultCountryCode);
  else setRow('dotCountry', 'valCountry', 'warn', 'opcional');

  // Whaticket card
  if (!s.whatpipeToken) {
    setRow('dotWaToken', 'valWaToken', 'err', 'No configurado');
    setRow('dotConnections', 'valConnections', 'err', 'Configura token');
    setRow('dotDefault', 'valDefault', 'err', '—');
    return;
  }
  setRow('dotWaToken', 'valWaToken', 'ok', 'configurado');

  try {
    const cResp = await chrome.runtime.sendMessage({ action: 'getConnections' });
    if (!cResp || !cResp.success) {
      setRow('dotConnections', 'valConnections', 'err', 'Error: ' + ((cResp && cResp.error) || 'desconocido'));
      setRow('dotDefault', 'valDefault', 'err', '—');
      return;
    }
    const conns = Array.isArray(cResp.connections) ? cResp.connections : [];
    const connected = conns.filter(c => c.status === 'CONNECTED').length;
    if (conns.length === 0) setRow('dotConnections', 'valConnections', 'err', 'Ninguna');
    else if (connected === 0) setRow('dotConnections', 'valConnections', 'err', `${conns.length} total, 0 conectadas`);
    else setRow('dotConnections', 'valConnections', 'ok', `${connected}/${conns.length} conectada${connected === 1 ? '' : 's'}`);

    if (!s.defaultConnectionId) {
      setRow('dotDefault', 'valDefault', 'warn', 'No seleccionada');
    } else {
      const match = conns.find(c => String(c.id) === String(s.defaultConnectionId));
      if (!match) setRow('dotDefault', 'valDefault', 'err', 'ID no existe');
      else if (match.status === 'CONNECTED') setRow('dotDefault', 'valDefault', 'ok', match.name);
      else setRow('dotDefault', 'valDefault', 'warn', `${match.name} (${match.status || 'inactiva'})`);
    }
  } catch (err) {
    setRow('dotConnections', 'valConnections', 'err', err.message);
    setRow('dotDefault', 'valDefault', 'err', '—');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('refreshBtn').addEventListener('click', refreshAll);
  refreshAll();
});
