// SuperPipeWhat — background service worker unificado
// Enruta mensajes de dos content scripts:
//   - content/whaticket.js  (panel PipeWhat dentro de *.whaticket.com)
//   - content/pipedrive.js  (envío Whaticket dentro de *.pipedrive.com)

// ============================================================
// Migración de claves legacy pre-WhatPipe
// ============================================================
// Las claves de Whaticket/WhatPipe se conservan con sus nombres originales
// (whatpipeToken, whatpipeTemplates, defaultConnectionId, senderCompany,
// buttonMode) porque los content scripts las leen/escriben/observan
// directamente. Las claves de PipeWhat (pipedriveApiToken, pipedriveCompany,
// defaultCountryCode, smartBccEmail, extraHosts) no colisionan con las de
// Whaticket, así que pueden coexistir en el mismo storage.
async function migrateLegacyKeys() {
  // Rename de la versión anterior de WhatPipe (branding previo "Whaticket")
  const r = await chrome.storage.local.get(["whaticketToken", "whaticketTemplates", "whatpipeToken", "whatpipeTemplates"]);
  const patch = {};
  const remove = [];
  if (r.whaticketToken && !r.whatpipeToken) patch.whatpipeToken = r.whaticketToken;
  if (r.whaticketToken !== undefined) remove.push("whaticketToken");
  if (Array.isArray(r.whaticketTemplates) && !Array.isArray(r.whatpipeTemplates)) patch.whatpipeTemplates = r.whaticketTemplates;
  if (r.whaticketTemplates !== undefined) remove.push("whaticketTemplates");
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (remove.length) await chrome.storage.local.remove(remove);
}

// ============================================================
// Pipedrive API (PipeWhat) — wrapper con retry y cache
// ============================================================
const PD_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const PD_MAX_RETRIES = 1;
const PD_RETRY_BASE_MS = 600;

async function pdFetch(path, options = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await pdFetchOnce(path, options);
    } catch (err) {
      const code = err && err.pdStatus;
      const isTimeout = err && err.message === "Pipedrive: timeout";
      const isServer = code >= 500 && code < 600;
      const isRate = code === 429;
      const isNetwork = !code && !isTimeout && err && /network|failed to fetch/i.test(err.message || "");
      const retryable = isTimeout || isServer || isRate || isNetwork;
      if (!retryable || attempt >= PD_MAX_RETRIES) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, PD_RETRY_BASE_MS * attempt));
    }
  }
}

async function pdFetchOnce(path, options = {}) {
  const { pipedriveApiToken, pipedriveCompany } = await chrome.storage.local.get([
    "pipedriveApiToken",
    "pipedriveCompany"
  ]);
  if (!pipedriveApiToken) throw new Error("Token de Pipedrive no configurado");
  if (!pipedriveCompany) throw new Error("Subdominio de Pipedrive no configurado");

  const method = options.method || "GET";
  const url = `https://${pipedriveCompany}.pipedrive.com/api/v1/${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PD_TIMEOUT_MS);
  const headers = {
    "x-api-token": pipedriveApiToken,
    "Accept": "application/json"
  };
  const init = { method, headers, signal: controller.signal };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      let detail = "";
      try {
        const j = await resp.json();
        detail = j.error || j.message || "";
      } catch {}
      const e = new Error(`Pipedrive ${resp.status}${detail ? ": " + detail : ""} en ${path}`);
      e.pdStatus = resp.status;
      throw e;
    }
    const json = await resp.json();
    return json && json.data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Pipedrive: timeout");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function phoneVariants(raw, countryCode) {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (!digits) return [];
  const cc = String(countryCode || "").replace(/[^0-9]/g, "");
  const set = new Set();
  set.add(digits);
  set.add("+" + digits);
  if (cc && digits.startsWith(cc)) {
    const rest = digits.slice(cc.length);
    set.add(rest);
    if (cc === "54" && rest.startsWith("9")) set.add(rest.slice(1));
    if (cc === "54" && !rest.startsWith("9")) set.add("9" + rest);
  }
  if (cc && !digits.startsWith(cc)) {
    set.add(cc + digits);
    set.add("+" + cc + digits);
  }
  if (digits.length >= 10) set.add(digits.slice(-10));
  if (digits.length >= 8) set.add(digits.slice(-8));
  return Array.from(set).filter(Boolean);
}

async function searchPersonByPhone(phone) {
  const cacheKey = `search:${phone}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { defaultCountryCode } = await chrome.storage.local.get("defaultCountryCode");
  const variants = phoneVariants(phone, defaultCountryCode);

  for (const v of variants) {
    const path = `persons/search?term=${encodeURIComponent(v)}&fields=phone&exact_match=false&limit=5`;
    const data = await pdFetch(path);
    const items = (data && data.items) || [];
    if (items.length > 0) {
      const result = { matched: true, variant: v, items };
      cacheSet(cacheKey, result);
      return result;
    }
  }

  const miss = { matched: false, variant: null, items: [] };
  cacheSet(cacheKey, miss);
  return miss;
}

async function getPersonBundle(personId) {
  const cacheKey = `bundle:${personId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const [person, deals, stages, pipelines] = await Promise.all([
    pdFetch(`persons/${personId}`),
    pdFetch(`persons/${personId}/deals?status=all_not_deleted&limit=20`).catch(() => []),
    getAllStages().catch(() => []),
    getPipelines().catch(() => [])
  ]);

  const stageMap = new Map((stages || []).map((s) => [s.id, s]));
  const pipelineMap = new Map((pipelines || []).map((p) => [p.id, p]));
  const enrichedDeals = (deals || []).map((d) => {
    if (!d) return d;
    const s = stageMap.get(d.stage_id);
    const pid = d.pipeline_id || (s && s.pipeline_id);
    const pl = pid ? pipelineMap.get(pid) : null;
    return {
      ...d,
      stage_name: s ? s.name : d.stage_name,
      pipeline_id: pid || d.pipeline_id,
      pipeline_name: pl ? pl.name : d.pipeline_name
    };
  });

  const result = { person, deals: enrichedDeals };
  cacheSet(cacheKey, result);
  return result;
}

async function getDealFlow(dealId, limit = 15) {
  const cacheKey = `flow:${dealId}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const [flow, stages, pipelines] = await Promise.all([
    pdFetch(`deals/${dealId}/flow?limit=${limit}`),
    getAllStages().catch(() => []),
    getPipelines().catch(() => [])
  ]);

  const stageMap = new Map((stages || []).map((s) => [String(s.id), s]));
  const pipelineMap = new Map((pipelines || []).map((p) => [String(p.id), p]));

  const enriched = (flow || []).map((item) => {
    if (!item) return item;
    const type = item.object || item.type;
    if (type !== "dealChange") return item;
    const d = item.data || {};
    const patch = {};
    if (d.field_key === "stage_id") {
      patch.old_value_label = (stageMap.get(String(d.old_value)) || {}).name;
      patch.new_value_label = (stageMap.get(String(d.new_value)) || {}).name;
      patch.friendly_field = "Etapa";
    } else if (d.field_key === "pipeline_id") {
      patch.old_value_label = (pipelineMap.get(String(d.old_value)) || {}).name;
      patch.new_value_label = (pipelineMap.get(String(d.new_value)) || {}).name;
      patch.friendly_field = "Pipeline";
    } else if (d.field_key === "status") {
      patch.friendly_field = "Estado";
    } else if (d.field_key === "value") {
      patch.friendly_field = "Valor";
    } else if (d.field_key === "owner_id") {
      patch.friendly_field = "Dueño";
    }
    return { ...item, data: { ...d, ...patch } };
  });

  cacheSet(cacheKey, enriched);
  return enriched;
}

function invalidateDealRelated(dealId, personId) {
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`flow:${dealId}:`)) cache.delete(k);
  }
  if (personId) cache.delete(`bundle:${personId}`);
}

async function createNote({ dealId, personId, content }) {
  if (!content || !content.trim()) throw new Error("La nota está vacía");
  const body = { content: content.trim() };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  const data = await pdFetch("notes", { method: "POST", body });
  invalidateDealRelated(dealId, personId);
  return data;
}

async function getAllStages() {
  const cacheKey = "stages:all";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const data = await pdFetch("stages") || [];
  cacheSet(cacheKey, data);
  return data;
}

async function updateDeal(dealId, updates) {
  if (!dealId) throw new Error("Falta dealId");
  if (!updates || !Object.keys(updates).length) throw new Error("Sin cambios");
  const data = await pdFetch(`deals/${dealId}`, { method: "PUT", body: updates });
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith("bundle:") || k.startsWith(`flow:${dealId}:`)) cache.delete(k);
  }
  return data;
}

async function getUsers() {
  const cacheKey = "users:all";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const data = await pdFetch("users") || [];
  const active = data.filter((u) => u && u.active_flag !== false).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  cacheSet(cacheKey, active);
  return active;
}

async function getPipelines() {
  const cacheKey = "pipelines:all";
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const data = await pdFetch("pipelines") || [];
  cacheSet(cacheKey, data);
  return data;
}

async function completeActivity(id) {
  if (!id) throw new Error("Falta id de actividad");
  const data = await pdFetch(`activities/${id}`, { method: "PUT", body: { done: true } });
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith("bundle:") || k.startsWith("flow:")) cache.delete(k);
  }
  return data;
}

async function createDeal({ title, value, currency, personId, stageId }) {
  if (!title || !title.trim()) throw new Error("Falta el título");
  const body = { title: title.trim() };
  if (personId) body.person_id = personId;
  if (value != null && value !== "") body.value = Number(value);
  if (currency) body.currency = String(currency).toUpperCase();
  if (stageId) body.stage_id = Number(stageId);
  const data = await pdFetch("deals", { method: "POST", body });
  if (personId) cache.delete(`bundle:${personId}`);
  return data;
}

async function addPersonContact({ personId, phone, email }) {
  if (!personId) throw new Error("Falta personId");
  if (!phone && !email) throw new Error("Indicá teléfono o email");
  const current = await pdFetch(`persons/${personId}`);
  const body = {};
  if (phone) {
    const phones = Array.isArray(current.phone) ? current.phone.filter((p) => p && p.value) : [];
    phones.push({ value: String(phone), label: "other", primary: false });
    body.phone = phones;
  }
  if (email) {
    const emails = Array.isArray(current.email) ? current.email.filter((e) => e && e.value) : [];
    emails.push({ value: String(email), label: "other", primary: false });
    body.email = emails;
  }
  const data = await pdFetch(`persons/${personId}`, { method: "PUT", body });
  cache.delete(`bundle:${personId}`);
  return data;
}

async function createPerson({ name, phone, email }) {
  if (!name || !name.trim()) throw new Error("Falta el nombre");
  const body = { name: name.trim() };
  if (phone) body.phone = [{ value: String(phone), primary: true }];
  if (email) body.email = [{ value: String(email), primary: true }];
  const data = await pdFetch("persons", { method: "POST", body });
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith("search:")) cache.delete(k);
  }
  return data;
}

async function createActivity({ dealId, personId, subject, type, dueDate, dueTime, note }) {
  if (!subject || !subject.trim()) throw new Error("El asunto es obligatorio");
  const body = {
    subject: subject.trim(),
    type: type || "task"
  };
  if (dealId) body.deal_id = dealId;
  if (personId) body.person_id = personId;
  if (dueDate) body.due_date = dueDate;
  if (dueTime) body.due_time = dueTime;
  if (note && note.trim()) body.note = note.trim();
  const data = await pdFetch("activities", { method: "POST", body });
  invalidateDealRelated(dealId, personId);
  return data;
}

// GET /files/:id devuelve un objeto con `url` pre-firmada (S3) que no requiere
// header de auth. Así el content script puede abrir adjuntos sin pasar el
// token por URL ni recibir 401.
async function getFileDownloadUrl(fileId) {
  if (!fileId) throw new Error("Falta fileId");
  const data = await pdFetch(`files/${encodeURIComponent(fileId)}`);
  const signed = data && (data.url || data.remote_url);
  if (!signed) throw new Error("Pipedrive no devolvió URL para este archivo");
  return signed;
}

async function lookupByPhone(phone) {
  const search = await searchPersonByPhone(phone);
  if (!search.matched) return { matched: false };

  const personId = search.items[0].item.id;
  const bundle = await getPersonBundle(personId);
  return { matched: true, ...bundle };
}

// ============================================================
// Whaticket API (WhatPipe) — envío de mensajes y conexiones
// ============================================================
const WA_API_BASE = "https://api.whaticket.com/api/v1";

async function sendWhaticketMessage({ number, body, connectionId, mediaUrl, pipedriveEntity, pageUrl }) {
  const { whatpipeToken, defaultConnectionId } = await chrome.storage.local.get([
    "whatpipeToken",
    "defaultConnectionId"
  ]);

  if (!whatpipeToken) {
    throw new Error("Token de Whaticket no configurado. Ve a Opciones de la extensión.");
  }

  const connId = connectionId || defaultConnectionId;
  if (!connId) {
    throw new Error("No se ha seleccionado una conexión de WhatsApp. Configura una por defecto en Opciones.");
  }

  const cleanNumber = String(number || "").replace(/[^0-9]/g, "");
  if (cleanNumber.length < 10) {
    throw new Error("Número de teléfono inválido. Debe tener al menos 10 dígitos.");
  }

  const messageObj = { number: cleanNumber, body: String(body || "").trim() };
  if (mediaUrl && typeof mediaUrl === "string" && mediaUrl.trim()) {
    messageObj.mediaUrl = mediaUrl.trim();
  }

  const payload = { connectionId: connId, messages: [messageObj] };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${WA_API_BASE}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${whatpipeToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Tiempo de espera agotado al enviar mensaje");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let errorMsg = `Error ${response.status}`;
    try {
      const errorData = await response.json();
      errorMsg = errorData.error || errorData.message || errorMsg;
    } catch {
      try { errorMsg = await response.text(); } catch {}
    }
    throw new Error(errorMsg);
  }

  const result = await response.json();

  // Best-effort: dejar registro del envío en Pipedrive como nota. Fallar acá
  // no debe revertir el envío — el mensaje ya salió.
  logSentAsPipedriveNote({
    number: cleanNumber,
    body: messageObj.body,
    mediaUrl: messageObj.mediaUrl,
    connectionId: connId,
    entity: pipedriveEntity,
    pageUrl
  }).catch((err) => console.debug("[SuperPipeWhat] no pude crear la nota:", err.message));

  return { success: true, result };
}

// Cache de conexiones Whaticket para resolver nombres al loggear la nota.
let waConnectionsCache = null;
async function getConnectionNameCached(id) {
  if (!id) return null;
  const now = Date.now();
  if (!waConnectionsCache || now - waConnectionsCache.at > 5 * 60 * 1000) {
    try {
      const list = await getWhaticketConnections();
      waConnectionsCache = { at: now, list: Array.isArray(list) ? list : [] };
    } catch {
      waConnectionsCache = { at: now, list: [] };
    }
  }
  const hit = waConnectionsCache.list.find((c) => String(c.id) === String(id));
  return hit ? hit.name : null;
}

function buildSentNoteBody({ number, body, mediaUrl, connectionName }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const lines = [];
  lines.push(`📱 WhatsApp enviado vía Whaticket — ${stamp}`);
  lines.push("");
  lines.push(`A: +${number}`);
  if (connectionName) lines.push(`Conexión: ${connectionName}`);
  lines.push("");
  lines.push(body || "(mensaje vacío)");
  if (mediaUrl) {
    lines.push("");
    lines.push(`📎 ${mediaUrl}`);
  }
  return lines.join("\n");
}

async function logSentAsPipedriveNote({ number, body, mediaUrl, connectionId, entity, pageUrl }) {
  const { logSentAsNote = true, pipedriveApiToken, pipedriveCompany } = await chrome.storage.local.get([
    "logSentAsNote",
    "pipedriveApiToken",
    "pipedriveCompany"
  ]);
  if (logSentAsNote === false) return;
  if (!pipedriveApiToken || !pipedriveCompany) return;

  // Resolve entity: prefer the one the content script detected (handles
  // preview drawer); otherwise try parsing the pageUrl.
  let resolved = entity;
  if (!resolved && pageUrl) {
    try {
      const u = new URL(pageUrl);
      const m = u.pathname.match(/\/(deal|person|leads|organization)\/([\w-]+)/);
      if (m) resolved = { kind: m[1], id: m[2] };
    } catch {}
  }
  if (!resolved || !resolved.kind || !resolved.id) return;

  const connectionName = await getConnectionNameCached(connectionId);
  const content = buildSentNoteBody({ number, body, mediaUrl, connectionName });

  const notePayload = { content };
  if (resolved.kind === "deal") notePayload.deal_id = Number(resolved.id);
  else if (resolved.kind === "person") notePayload.person_id = Number(resolved.id);
  else if (resolved.kind === "organization") notePayload.org_id = Number(resolved.id);
  else if (resolved.kind === "leads") notePayload.lead_id = String(resolved.id);
  else return;

  await pdFetch("notes", { method: "POST", body: notePayload });

  // Invalidar flow cache del deal para que el timeline del panel refleje la nota.
  if (resolved.kind === "deal") invalidateDealRelated(resolved.id, null);
}

async function getWhaticketConnections() {
  const { whatpipeToken } = await chrome.storage.local.get("whatpipeToken");
  if (!whatpipeToken) throw new Error("Token de Whaticket no configurado.");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${WA_API_BASE}/whatsapps`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${whatpipeToken}` },
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Tiempo de espera agotado al obtener conexiones");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) throw new Error(`Error al obtener conexiones: ${response.status}`);
  return await response.json();
}

// pdFetch variante usada por el content script de Pipedrive: determina el host
// desde la URL (no desde pipedriveCompany, porque ahí YA estamos en el dominio).
const PD_LOOKUP_TIMEOUT_MS = 10000;
async function pdFetchByHost(hostname, path, token) {
  const apiUrl = `https://${hostname}/api/v1/${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PD_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { "x-api-token": token }
    });
    if (!response.ok) throw new Error(`Pipedrive API ${path}: ${response.status}`);
    const json = await response.json();
    return json && json.data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Pipedrive API: timeout");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pipedriveLookup(pageUrl) {
  const { pipedriveApiToken } = await chrome.storage.local.get("pipedriveApiToken");
  if (!pipedriveApiToken) return null;
  if (!pageUrl) return null;

  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  if (!url.hostname.endsWith("pipedrive.com")) return null;

  const match = url.pathname.match(/\/(deal|person|organization|leads)\/([\w-]+)/);
  if (!match) return null;
  const [, kind, id] = match;

  const endpoint = kind === "leads" ? `leads/${id}` : `${kind}s/${id}`;
  const data = await pdFetchByHost(url.hostname, endpoint, pipedriveApiToken);
  if (!data) return { kind, data: null };

  let person = null;
  let organization = null;
  if (kind === "leads") {
    const personId = typeof data.person_id === "number" ? data.person_id : (data.person_id && data.person_id.value);
    const orgId = typeof data.organization_id === "number" ? data.organization_id : (data.organization_id && data.organization_id.value);
    const tasks = [];
    if (personId) tasks.push(pdFetchByHost(url.hostname, `persons/${personId}`, pipedriveApiToken).catch(() => null).then(d => { person = d; }));
    if (orgId) tasks.push(pdFetchByHost(url.hostname, `organizations/${orgId}`, pipedriveApiToken).catch(() => null).then(d => { organization = d; }));
    if (tasks.length) await Promise.all(tasks);
  }

  return { kind, data, person, organization };
}

// ============================================================
// Self-hosted Whaticket: registrar content script en hosts extra
// ============================================================
function scriptIdForHost(host) {
  return "spw-" + host.replace(/[^a-z0-9]/gi, "-");
}

async function registerContentScriptForHost(host) {
  const id = scriptIdForHost(host);
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch {}
  await chrome.scripting.registerContentScripts([{
    id,
    matches: [`https://${host}/*`],
    js: ["content/whaticket.js"],
    css: ["content/whaticket.css"],
    runAt: "document_idle"
  }]);
}

async function registerAllStoredHosts() {
  const { extraHosts = [] } = await chrome.storage.local.get("extraHosts");
  for (const host of extraHosts) {
    try { await registerContentScriptForHost(host); } catch (e) {
      console.warn("SuperPipeWhat: no pude registrar host", host, e.message);
    }
  }
}

async function addExtraHost(host) {
  const clean = String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!clean) throw new Error("Host vacío");
  if (!/^[a-z0-9.-]+$/.test(clean)) throw new Error("Host inválido");

  const hasPerm = await chrome.permissions.contains({ origins: [`https://${clean}/*`] });
  if (!hasPerm) throw new Error("Falta permiso sobre " + clean);

  await registerContentScriptForHost(clean);

  const { extraHosts = [] } = await chrome.storage.local.get("extraHosts");
  if (!extraHosts.includes(clean)) {
    extraHosts.push(clean);
    await chrome.storage.local.set({ extraHosts });
  }
  return { host: clean };
}

async function removeExtraHost(host) {
  const id = scriptIdForHost(host);
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch {}
  try { await chrome.permissions.remove({ origins: [`https://${host}/*`] }); } catch {}
  const { extraHosts = [] } = await chrome.storage.local.get("extraHosts");
  const next = extraHosts.filter((h) => h !== host);
  await chrome.storage.local.set({ extraHosts: next });
  return true;
}

// ============================================================
// Lifecycle: migración + registrar hosts extra
// ============================================================
chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyKeys();
  await registerAllStoredHosts();
});
chrome.runtime.onStartup.addListener(async () => {
  await migrateLegacyKeys();
  await registerAllStoredHosts();
});

// ============================================================
// Atajos de teclado
// ============================================================
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null || !tab.url) return;

    if (command === "toggle-panel") {
      // Va al tab activo si es Whaticket (o host extra); si no, ignora.
      chrome.tabs.sendMessage(tab.id, { action: "togglePanel" }).catch(() => {});
    } else if (command === "open-send-modal") {
      if (!/https:\/\/[^/]*pipedrive\.com\//.test(tab.url)) return;
      chrome.tabs.sendMessage(tab.id, { action: "openSendModal" }, () => void chrome.runtime.lastError);
    }
  });
});

// ============================================================
// Router único de mensajes
// ============================================================
// Claves unificadas que devuelve getSettings. Los content scripts piden todo
// y cada uno toma lo que le sirve.
const SETTINGS_KEYS = [
  // PipeWhat (panel en Whaticket)
  "pipedriveApiToken",
  "pipedriveCompany",
  "defaultCountryCode",
  "smartBccEmail",
  "whaticketUrl",
  // WhatPipe (FAB en Pipedrive)
  "whatpipeToken",
  "defaultConnectionId",
  "senderCompany",
  "buttonMode"
];

function ok(sendResponse) { return (data) => sendResponse({ success: true, data }); }
function fail(sendResponse) { return (err) => sendResponse({ success: false, error: err.message }); }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.action) return;

  if (msg.action === "getSettings") {
    chrome.storage.local.get(SETTINGS_KEYS, (settings) => {
      sendResponse({ success: true, settings });
    });
    return true;
  }

  if (msg.action === "clearCache") {
    cache.clear();
    sendResponse({ success: true });
    return true;
  }

  // ---- Pipedrive (PipeWhat) ----
  if (msg.action === "lookupByPhone") {
    lookupByPhone(msg.phone).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "getDealFlow") {
    getDealFlow(msg.dealId, msg.limit || 15).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "createNote") {
    createNote(msg.payload).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "createActivity") {
    createActivity(msg.payload).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "getStages") {
    getAllStages().then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "updateDeal") {
    updateDeal(msg.dealId, msg.updates || {}).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "createPerson") {
    createPerson(msg.payload || {}).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "getPipelines") {
    getPipelines().then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "completeActivity") {
    completeActivity(msg.activityId).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "createDeal") {
    createDeal(msg.payload || {}).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "getUsers") {
    getUsers().then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "addPersonContact") {
    addPersonContact(msg.payload || {}).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "addExtraHost") {
    addExtraHost(msg.host).then(ok(sendResponse)).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "removeExtraHost") {
    removeExtraHost(msg.host).then(() => sendResponse({ success: true })).catch(fail(sendResponse));
    return true;
  }
  if (msg.action === "listExtraHosts") {
    chrome.storage.local.get("extraHosts", (s) => sendResponse({ success: true, data: s.extraHosts || [] }));
    return true;
  }
  if (msg.action === "getFileDownloadUrl") {
    getFileDownloadUrl(msg.fileId)
      .then((url) => sendResponse({ success: true, data: url }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ---- Whaticket (WhatPipe) ----
  if (msg.action === "sendMessage") {
    sendWhaticketMessage(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.action === "getConnections") {
    getWhaticketConnections()
      .then((connections) => sendResponse({ success: true, connections }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.action === "pipedriveLookup") {
    pipedriveLookup(msg.url)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Limpiar cache al cambiar credenciales de Pipedrive
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pipedriveApiToken || changes.pipedriveCompany) cache.clear();
});
