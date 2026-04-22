// SuperPipeWhat — options script unificado (merge de PipeWhat + WhatPipe)

function flashInline(id, message, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `inline-status show ${type || 'success'}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'inline-status'; el.textContent = ''; }, 2000);
}

function cleanCompany(v) {
  return String(v || '').trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.pipedrive\.com.*$/, '')
    .replace(/\/.*$/, '');
}

function cleanHost(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

// ============ Tabs ============
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  const activate = (name) => {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    try { localStorage.setItem('superpipewhat:lastTab', name); } catch {}
  };
  tabs.forEach(t => t.addEventListener('click', () => activate(t.dataset.tab)));
  try {
    const saved = localStorage.getItem('superpipewhat:lastTab');
    if (saved && ['pipedrive', 'whaticket', 'templates', 'help'].includes(saved)) activate(saved);
  } catch {}
}

// ============ Load all settings ============
async function loadAll() {
  const s = await chrome.storage.local.get([
    'pipedriveApiToken', 'pipedriveCompany', 'defaultCountryCode', 'smartBccEmail',
    'whatpipeToken', 'defaultConnectionId', 'senderCompany', 'buttonMode'
  ]);
  document.getElementById('pipedriveApiToken').value = s.pipedriveApiToken || '';
  document.getElementById('pipedriveCompany').value = s.pipedriveCompany || '';
  document.getElementById('defaultCountryCode').value = s.defaultCountryCode || '';
  document.getElementById('smartBccEmail').value = s.smartBccEmail || '';
  document.getElementById('token').value = s.whatpipeToken || '';
  document.getElementById('defaultConnection').value = s.defaultConnectionId || '';
  document.getElementById('senderCompany').value = s.senderCompany || '';
  document.getElementById('buttonMode').value = s.buttonMode === 'inline' ? 'inline' : 'floating';
}

// ============ PIPEDRIVE tab handlers ============
async function savePipedrive() {
  const token = document.getElementById('pipedriveApiToken').value.trim();
  const company = cleanCompany(document.getElementById('pipedriveCompany').value);
  if (!company) return flashInline('pipedriveStatus', 'Subdominio requerido', 'error');
  if (!token) return flashInline('pipedriveStatus', 'Token requerido', 'error');
  await chrome.storage.local.set({ pipedriveApiToken: token, pipedriveCompany: company });
  flashInline('pipedriveStatus', 'Guardado ✓', 'success');
}

async function saveCountry() {
  const cc = document.getElementById('defaultCountryCode').value.replace(/[^0-9]/g, '');
  await chrome.storage.local.set({ defaultCountryCode: cc || null });
  flashInline('countryStatus', 'Guardado ✓', 'success');
}

async function saveSmartBcc() {
  const v = document.getElementById('smartBccEmail').value.trim();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return flashInline('smartBccStatus', 'Email inválido', 'error');
  }
  await chrome.storage.local.set({ smartBccEmail: v });
  flashInline('smartBccStatus', 'Guardado ✓', 'success');
}

async function clearCache() {
  const resp = await chrome.runtime.sendMessage({ action: 'clearCache' });
  flashInline('cacheStatus', resp && resp.success ? 'Cache vaciada ✓' : 'Error al vaciar', resp && resp.success ? 'success' : 'error');
}

async function renderHosts() {
  const list = document.getElementById('hostsList');
  const resp = await chrome.runtime.sendMessage({ action: 'listExtraHosts' });
  const hosts = (resp && resp.success && resp.data) || [];
  list.replaceChildren();
  if (hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Sin dominios adicionales autorizados. Por defecto corre en *.whaticket.com.';
    list.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const row = document.createElement('div');
    row.className = 'host-row';
    const code = document.createElement('code');
    code.textContent = host;
    const btn = document.createElement('button');
    btn.textContent = 'Quitar';
    btn.addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ action: 'removeExtraHost', host });
      if (r && r.success) { flashInline('hostsStatus', `Quitado ${host}`, 'success'); renderHosts(); }
      else flashInline('hostsStatus', 'Error al quitar', 'error');
    });
    row.append(code, btn);
    list.appendChild(row);
  }
}

async function addHost() {
  const host = cleanHost(document.getElementById('whaticketHost').value);
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return flashInline('hostsStatus', 'Dominio inválido', 'error');
  }
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
  } catch (e) {
    return flashInline('hostsStatus', 'Error pidiendo permiso: ' + e.message, 'error');
  }
  if (!granted) return flashInline('hostsStatus', 'Permiso denegado', 'error');

  const r = await chrome.runtime.sendMessage({ action: 'addExtraHost', host });
  if (r && r.success) {
    document.getElementById('whaticketHost').value = '';
    flashInline('hostsStatus', `Autorizado: ${host} — recargá la pestaña`, 'success');
    renderHosts();
  } else {
    flashInline('hostsStatus', (r && r.error) || 'Error', 'error');
  }
}

// ============ WHATICKET tab handlers ============
const statusDiv = () => document.getElementById('status');
function showStatus(message, type) {
  const d = statusDiv();
  d.textContent = message;
  d.className = `status ${type}`;
  d.style.display = 'block';
}

async function saveWhaticket() {
  const token = document.getElementById('token').value.trim();
  const defaultConn = document.getElementById('defaultConnection').value.trim();
  if (!token) return flashInline('whatpipeStatus', 'Ingresa tu token', 'error');
  await chrome.storage.local.set({ whatpipeToken: token, defaultConnectionId: defaultConn || null });
  flashInline('whatpipeStatus', '✅ Guardado', 'success');
}

async function saveSenderCompany() {
  const v = document.getElementById('senderCompany').value.trim();
  await chrome.storage.local.set({ senderCompany: v || null });
  flashInline('senderCompanyStatus', '✅ Guardado', 'success');
}

async function saveButtonMode() {
  const mode = document.getElementById('buttonMode').value === 'inline' ? 'inline' : 'floating';
  await chrome.storage.local.set({ buttonMode: mode });
  flashInline('buttonModeStatus', '✅ Guardado', 'success');
}

async function testConnection() {
  const token = document.getElementById('token').value.trim();
  const btn = document.getElementById('testBtn');
  if (!token) return showStatus('Primero ingresa un token', 'error');
  showStatus('Probando conexión...', 'success');
  btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getConnections' });
    if (resp && resp.success) {
      showStatus(`✅ Conexión exitosa! Se encontraron ${resp.connections.length} conexiones.`, 'success');
      renderConnections(resp.connections);
    } else {
      showStatus('❌ Error: ' + ((resp && resp.error) || 'Token inválido o problema de red'), 'error');
    }
  } catch (err) {
    showStatus('❌ Error de conexión: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadConnections() {
  const token = document.getElementById('token').value.trim();
  const btn = document.getElementById('loadConnectionsBtn');
  if (!token) return showStatus('Primero guarda tu token', 'error');
  btn.disabled = true;
  btn.textContent = 'Cargando...';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getConnections' });
    if (resp && resp.success) {
      renderConnections(resp.connections);
      showStatus(`✅ ${resp.connections.length} conexiones cargadas`, 'success');
    } else {
      showStatus('Error: ' + ((resp && resp.error) || 'No se pudieron cargar'), 'error');
    }
  } catch (err) {
    showStatus('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cargar conexiones';
  }
}

function renderConnections(connections) {
  const section = document.getElementById('connectionsSection');
  const list = document.getElementById('connectionsList');
  section.style.display = 'block';
  list.innerHTML = '';
  if (!connections || connections.length === 0) {
    list.innerHTML = '<div class="conn-item" style="color:#64748b;">No hay conexiones disponibles</div>';
    return;
  }
  connections.forEach(conn => {
    const item = document.createElement('div');
    item.className = 'conn-item';
    const isConnected = conn.status === 'CONNECTED';
    const left = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = `status-dot ${isConnected ? 'connected' : 'disconnected'}`;
    const nameEl = document.createElement('strong');
    nameEl.textContent = conn.name;
    nameEl.style.marginRight = '6px';
    const idEl = document.createElement('span');
    idEl.style.cssText = 'color:#94a3b8;font-size:12px;';
    idEl.textContent = `(${conn.id})`;
    left.append(dot, nameEl, idEl);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex; align-items:center; gap:10px;';
    const statusEl = document.createElement('span');
    statusEl.style.cssText = `font-size:12px; font-weight:600; color:${isConnected ? '#16a34a' : '#dc2626'};`;
    statusEl.textContent = conn.status || 'Desconocido';
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Usar como defecto';
    right.append(statusEl, btn);

    item.append(left, right);
    btn.addEventListener('click', () => {
      document.getElementById('defaultConnection').value = conn.id;
      chrome.storage.local.set({ defaultConnectionId: conn.id }, () => {
        showStatus(`✅ ${conn.name} establecida como conexión por defecto`, 'success');
        setTimeout(() => statusDiv().style.display = 'none', 2000);
      });
    });
    list.appendChild(item);
  });
}

// ============ TEMPLATES ============
const DEFAULT_TEMPLATES = [
  { id: 't-recontacto-corto', name: 'Recontacto corto',
    body: 'Hola {{nombre}}, ¿cómo andás? Te escribo para retomar la charla y ver en qué te podemos dar una mano. ¿Tenés un minuto?', mediaUrl: '' },
  { id: 't-recontacto-7dias', name: 'Recontacto 7 días',
    body: 'Hola {{nombre}}, te escribo desde {{mi_empresa}}. Hace unos días estuvimos hablando sobre tu proyecto y quería saber si llegaste a ver la propuesta. Cualquier cosa, me avisás.', mediaUrl: '' },
  { id: 't-seguimiento', name: 'Seguimiento propuesta',
    body: 'Hola {{nombre}}, ¿cómo va todo? Te escribo para hacerte un seguimiento de la propuesta que te mandamos. ¿Te quedó alguna duda que te pueda resolver?', mediaUrl: '' }
];
let editingId = null;

function loadTemplates() {
  chrome.storage.local.get(['whatpipeTemplates'], (result) => {
    let templates = result.whatpipeTemplates;
    if (!Array.isArray(templates)) {
      templates = DEFAULT_TEMPLATES.slice();
      chrome.storage.local.set({ whatpipeTemplates: templates });
    }
    renderTemplates(templates);
  });
}
function saveTemplates(templates) {
  chrome.storage.local.set({ whatpipeTemplates: templates }, () => renderTemplates(templates));
}
function renderTemplates(templates) {
  const list = document.getElementById('templatesList');
  list.innerHTML = '';
  if (!templates.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No hay plantillas todavía. Crea la primera abajo.';
    list.appendChild(empty);
    return;
  }
  templates.forEach(tpl => {
    const card = document.createElement('div');
    card.className = 'tpl-card';
    const head = document.createElement('div');
    head.className = 'tpl-head';
    const title = document.createElement('div');
    title.className = 'tpl-title';
    title.textContent = tpl.name;
    const actions = document.createElement('div');
    actions.className = 'tpl-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = 'Editar';
    editBtn.addEventListener('click', () => startEdit(tpl));
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-secondary btn-sm';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', () => {
      const next = templates.filter(t => t.id !== tpl.id);
      saveTemplates(next);
      if (editingId === tpl.id) resetForm();
    });
    actions.append(editBtn, delBtn);
    head.append(title, actions);
    const body = document.createElement('div');
    body.className = 'tpl-body';
    body.textContent = tpl.body;
    card.append(head, body);
    if (tpl.mediaUrl) {
      const media = document.createElement('div');
      media.className = 'tpl-media';
      media.textContent = '📎 ' + tpl.mediaUrl;
      card.appendChild(media);
    }
    list.appendChild(card);
  });
}
function startEdit(tpl) {
  editingId = tpl.id;
  document.getElementById('tplName').value = tpl.name;
  document.getElementById('tplBody').value = tpl.body;
  document.getElementById('tplMedia').value = tpl.mediaUrl || '';
  document.getElementById('tplFormTitle').textContent = 'Editar plantilla';
  document.getElementById('addTplBtn').textContent = 'Guardar cambios';
  document.getElementById('cancelEditBtn').style.display = 'inline-block';
  document.getElementById('tplName').focus();
  document.getElementById('tplName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetForm() {
  editingId = null;
  document.getElementById('tplName').value = '';
  document.getElementById('tplBody').value = '';
  document.getElementById('tplMedia').value = '';
  document.getElementById('tplFormTitle').textContent = 'Nueva plantilla';
  document.getElementById('addTplBtn').textContent = 'Agregar plantilla';
  document.getElementById('cancelEditBtn').style.display = 'none';
}
function addOrUpdateTemplate() {
  const name = document.getElementById('tplName').value.trim();
  const body = document.getElementById('tplBody').value.trim();
  const mediaUrl = document.getElementById('tplMedia').value.trim();
  if (!name || !body) return showStatus('Nombre y mensaje son obligatorios', 'error');
  chrome.storage.local.get(['whatpipeTemplates'], (result) => {
    const templates = Array.isArray(result.whatpipeTemplates) ? result.whatpipeTemplates : [];
    if (editingId) {
      const idx = templates.findIndex(t => t.id === editingId);
      if (idx >= 0) templates[idx] = { id: editingId, name, body, mediaUrl };
      saveTemplates(templates);
      showStatus('✅ Plantilla actualizada', 'success');
    } else {
      templates.push({ id: `t-${Date.now()}`, name, body, mediaUrl });
      saveTemplates(templates);
      showStatus('✅ Plantilla agregada', 'success');
    }
    resetForm();
    setTimeout(() => { const d = statusDiv(); if (d) d.style.display = 'none'; }, 1500);
  });
}

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadAll();

  // Pipedrive tab
  document.getElementById('savePipedriveBtn').addEventListener('click', savePipedrive);
  document.getElementById('saveCountryBtn').addEventListener('click', saveCountry);
  document.getElementById('saveSmartBccBtn').addEventListener('click', saveSmartBcc);
  document.getElementById('addHostBtn').addEventListener('click', addHost);
  document.getElementById('clearCacheBtn').addEventListener('click', clearCache);
  renderHosts();

  // Whaticket tab
  document.getElementById('saveBtn').addEventListener('click', saveWhaticket);
  document.getElementById('testBtn').addEventListener('click', testConnection);
  document.getElementById('loadConnectionsBtn').addEventListener('click', loadConnections);
  document.getElementById('saveSenderCompanyBtn').addEventListener('click', saveSenderCompany);
  document.getElementById('saveButtonModeBtn').addEventListener('click', saveButtonMode);

  // Templates tab
  document.getElementById('addTplBtn').addEventListener('click', addOrUpdateTemplate);
  document.getElementById('cancelEditBtn').addEventListener('click', resetForm);
  loadTemplates();

  // Cross-tab sync
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.whatpipeTemplates) {
      const next = Array.isArray(changes.whatpipeTemplates.newValue) ? changes.whatpipeTemplates.newValue : [];
      renderTemplates(next);
    }
    const mirror = (key, inputId) => {
      if (changes[key]) {
        const el = document.getElementById(inputId);
        if (el && changes[key].newValue !== el.value) el.value = changes[key].newValue || '';
      }
    };
    mirror('whatpipeToken', 'token');
    mirror('defaultConnectionId', 'defaultConnection');
    mirror('pipedriveApiToken', 'pipedriveApiToken');
    mirror('pipedriveCompany', 'pipedriveCompany');
    mirror('defaultCountryCode', 'defaultCountryCode');
    mirror('senderCompany', 'senderCompany');
  });
});
