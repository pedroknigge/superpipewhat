// Content script for WhatPipe Pipedrive Extension
// Injects a floating button on Pipedrive pages and handles the send modal

(function() {
  'use strict';

  // Only run on Pipedrive
  if (!window.location.hostname.includes('pipedrive.com')) {
    return;
  }

  // Current UI mode: 'floating' (default) shows the bottom-right FAB;
  // 'inline' hides it and shows a small icon next to each tel: link.
  let uiMode = 'floating';

  // Inject the FAB container. In 'inline' mode the main send button is
  // hidden via a CSS class so the container can still host the mass-send
  // button that appears on row selection.
  function injectFAB() {
    const existing = document.getElementById('whatpipe-fab');
    if (existing) existing.remove();

    const fab = document.createElement('div');
    fab.id = 'whatpipe-fab';
    if (uiMode === 'inline') fab.classList.add('whatpipe-inline-mode');
    fab.innerHTML = `
      <button class="whatpipe-fab-btn" id="whatpipe-fab-send" title="Enviar mensaje (Alt+Shift+W)">
        <span class="fab-icon">📱</span>
        <span class="fab-text">WhatPipe</span>
      </button>
    `;
    document.body.appendChild(fab);

    fab.querySelector('#whatpipe-fab-send').addEventListener('click', () => openSendModal());
  }

  // ---------- Inline icon mode ----------
  // Scan for tel: links and inject a small WhatPipe icon next to each so
  // users can trigger the send modal per-phone. Idempotent via a data flag.
  function injectInlineIcons() {
    if (uiMode !== 'inline') return;
    const links = document.querySelectorAll('a[href^="tel:"]:not([data-whatpipe-inline])');
    links.forEach(link => {
      link.setAttribute('data-whatpipe-inline', '1');
      const raw = (link.getAttribute('href') || '').replace('tel:', '').trim();
      const num = raw.replace(/[^0-9+]/g, '');
      if (num.replace(/[^0-9]/g, '').length < 8) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'whatpipe-inline-icon';
      btn.title = 'Enviar WhatsApp con WhatPipe';
      btn.textContent = '📱';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSendModal(num.replace(/^\+/, ''));
      });
      link.insertAdjacentElement('afterend', btn);
    });
  }

  function removeInlineIcons() {
    document.querySelectorAll('.whatpipe-inline-icon').forEach(el => el.remove());
    document.querySelectorAll('a[data-whatpipe-inline]').forEach(el => el.removeAttribute('data-whatpipe-inline'));
  }

  let inlineObserver = null;
  function startInlineWatcher() {
    injectInlineIcons();
    if (inlineObserver) return;
    inlineObserver = new MutationObserver(() => {
      // Debounce by RAF so we don't re-scan for every mutation.
      if (inlineObserver._pending) return;
      inlineObserver._pending = true;
      requestAnimationFrame(() => {
        inlineObserver._pending = false;
        injectInlineIcons();
      });
    });
    inlineObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopInlineWatcher() {
    if (inlineObserver) { inlineObserver.disconnect(); inlineObserver = null; }
    removeInlineIcons();
  }

  async function applyUiMode() {
    const settings = await getSettings();
    const next = settings.buttonMode === 'inline' ? 'inline' : 'floating';
    if (next === uiMode && document.getElementById('whatpipe-fab')) return;
    uiMode = next;
    injectFAB();
    if (uiMode === 'inline') startInlineWatcher();
    else stopInlineWatcher();
  }

  // Detect the entity whose context the user is currently viewing. Cubre:
  //   1) Página directa (/deal/123, /leads/<uuid>, etc.)
  //   2) Query/hash (?selectedLead=<uuid>, #/lead/<uuid>, etc.)
  //   3) Drawer de preview — distintos data-test según entity.
  //   4) Último drawer visto recientemente (fallback memoizado).
  //
  // IDs de leads son UUID (string), el resto son numéricos.
  const ID_PATTERN = '([0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const ENTITY_LINK_RE = new RegExp(`/(deal|person|leads|organization)/${ID_PATTERN}`, 'i');

  let _lastPreviewEntity = null; // { kind, id, at: Date }

  function detectCurrentEntity() {
    // 1) URL path
    const m = location.pathname.match(ENTITY_LINK_RE);
    if (m) return { kind: m[1].toLowerCase(), id: m[2] };

    // 2) Query string (?selectedLead=uuid, ?leadId=uuid, ?dealId=123, etc.)
    const qs = location.search;
    const qsLead = qs.match(/[?&](?:selectedLead|leadId|lead)=([0-9a-f-]{8,})/i);
    if (qsLead) return { kind: 'leads', id: qsLead[1] };
    const qsDeal = qs.match(/[?&](?:selectedDeal|dealId|deal)=(\d+)/i);
    if (qsDeal) return { kind: 'deal', id: qsDeal[1] };
    const qsPerson = qs.match(/[?&](?:selectedPerson|personId|person)=(\d+)/i);
    if (qsPerson) return { kind: 'person', id: qsPerson[1] };
    const qsOrg = qs.match(/[?&](?:selectedOrganization|organizationId|org)=(\d+)/i);
    if (qsOrg) return { kind: 'organization', id: qsOrg[1] };

    // 3) Hash (#/lead/uuid, etc.)
    const hashMatch = location.hash.match(ENTITY_LINK_RE);
    if (hashMatch) return { kind: hashMatch[1].toLowerCase(), id: hashMatch[2] };

    // 4) "Ábrelo en una pestaña nueva" dentro de la preview. Pipedrive
    //    renderiza <a data-test="nav-button" href="/deal/123">… o /leads/<uuid>…
    //    dentro de los modales/drawers de preview. Es el indicador más
    //    confiable porque no depende del data-test del contenedor.
    const navButtons = document.querySelectorAll('a[data-test="nav-button"][href]');
    for (const nb of navButtons) {
      // Preferir los visibles (offsetParent != null filtra desplegables cerrados)
      if (nb.offsetParent === null) continue;
      const nm = nb.getAttribute('href').match(ENTITY_LINK_RE);
      if (nm) return { kind: nm[1].toLowerCase(), id: nm[2] };
    }
    // Si ninguno era visible, usar el primero que matchee igualmente.
    for (const nb of navButtons) {
      const nm = nb.getAttribute('href').match(ENTITY_LINK_RE);
      if (nm) return { kind: nm[1].toLowerCase(), id: nm[2] };
    }

    // 5) Drawer(s) visibles. Probamos varios data-test comunes y cualquier
    //    elemento con role=dialog.
    const drawerSelectors = [
      '[data-test="detailsDrawer"]',
      '[data-test*="Drawer"]',
      '[data-test*="drawer"]',
      '[data-test*="Preview"]',
      '[data-test*="preview"]',
      '[role="dialog"]',
      '[aria-modal="true"]'
    ];
    const drawers = document.querySelectorAll(drawerSelectors.join(', '));
    for (const drawer of drawers) {
      // Cualquier link interno a una entity cuenta
      const link = drawer.querySelector(
        'a[href*="/deal/"], a[href*="/person/"], a[href*="/leads/"], a[href*="/organization/"]'
      );
      if (link) {
        const dm = link.getAttribute('href').match(ENTITY_LINK_RE);
        if (dm) return { kind: dm[1].toLowerCase(), id: dm[2] };
      }
      // data-id en el drawer o en un descendiente (UUID o numérico)
      const rawId = drawer.getAttribute('data-id')
        || (drawer.querySelector('[data-id]') && drawer.querySelector('[data-id]').getAttribute('data-id'))
        || drawer.getAttribute('data-test-id')
        || (drawer.querySelector('[data-test-id]') && drawer.querySelector('[data-test-id]').getAttribute('data-test-id'));
      if (rawId && /^([0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(rawId)) {
        const pk = location.pathname.match(/\/(deal|person|lead|organization)s?\b/i) || [null, ''];
        let kind = pk[1] ? pk[1].toLowerCase() : null;
        if (kind === 'lead') kind = 'leads';
        // Si el ID parece UUID y no pudimos inferir kind de la URL → asumimos leads
        if (!kind && /-/.test(rawId)) kind = 'leads';
        // Si es numérico y no pudimos inferir, hacemos best-guess deal
        if (!kind) kind = 'deal';
        return { kind, id: rawId };
      }
    }

    // 6) Último entity detectado en un drawer reciente (≤ 60 s).
    if (_lastPreviewEntity && Date.now() - _lastPreviewEntity.at < 60 * 1000) {
      return { kind: _lastPreviewEntity.kind, id: _lastPreviewEntity.id };
    }

    return null;
  }

  const KIND_LABEL = { deal: 'Deal', person: 'Persona', organization: 'Organización', leads: 'Lead' };
  const KIND_ICON = { deal: '💼', person: '👤', organization: '🏢', leads: '🎯' };

  // Pinta (o esconde) el chip que indica si la nota automática va a ir a
  // Pipedrive al enviar. Se lee en vivo cada vez, no cacheamos.
  async function renderEntityChip(modal) {
    const chip = modal.querySelector('#whatpipe-entity-chip');
    if (!chip) return;

    const { logSentAsNote = true, pipedriveApiToken } = await new Promise((res) =>
      chrome.storage.local.get(['logSentAsNote', 'pipedriveApiToken'], res)
    );

    if (!pipedriveApiToken) {
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:12px;border-radius:8px;font-size:12.5px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;';
      chip.textContent = 'ℹ️ Sin token de Pipedrive — no se registrará nota al enviar.';
      return;
    }
    if (logSentAsNote === false) {
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:12px;border-radius:8px;font-size:12.5px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;';
      chip.textContent = 'ℹ️ Registro de nota desactivado en Opciones.';
      return;
    }

    const entity = detectCurrentEntity();
    if (entity) {
      const label = KIND_LABEL[entity.kind] || entity.kind;
      const icon = KIND_ICON[entity.kind] || '📌';
      const idShort = String(entity.id).length > 10 ? String(entity.id).slice(0, 8) + '…' : entity.id;
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:12px;border-radius:8px;font-size:12.5px;background:#dcfce7;color:#166534;border:1px solid #86efac;font-weight:600;';
      chip.textContent = `${icon} ${label} #${idShort} detectado — se creará nota en Pipedrive al enviar`;
    } else {
      chip.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:12px;border-radius:8px;font-size:12.5px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;';
      chip.textContent = '⚠️ No pude detectar la entidad de Pipedrive — no se creará nota. Abrí un deal/lead/persona (o su preview) para que lo registre.';
    }
  }

  // Observer global: cada vez que aparece un drawer/modal con un link a una
  // entity, cacheamos esa entity. Sirve de fallback cuando, en el momento del
  // envío, el DOM del drawer cambió y ya no tiene el link a la vista.
  function installPreviewEntityObserver() {
    const seen = new WeakSet();
    const scan = () => {
      const e = detectCurrentEntityFromDOMOnly();
      if (e) _lastPreviewEntity = { ...e, at: Date.now() };
    };
    const observer = new MutationObserver(() => {
      // throttle
      if (seen.has(scan)) return;
      seen.add(scan);
      setTimeout(() => { seen.delete(scan); scan(); }, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }

  // Versión del detector que sólo usa DOM (para el observer, sin caer en el
  // fallback de la propia caché).
  function detectCurrentEntityFromDOMOnly() {
    // Nav-button de la preview: el más confiable.
    const navButtons = document.querySelectorAll('a[data-test="nav-button"][href]');
    for (const nb of navButtons) {
      if (nb.offsetParent === null) continue;
      const nm = nb.getAttribute('href').match(ENTITY_LINK_RE);
      if (nm) return { kind: nm[1].toLowerCase(), id: nm[2] };
    }
    for (const nb of navButtons) {
      const nm = nb.getAttribute('href').match(ENTITY_LINK_RE);
      if (nm) return { kind: nm[1].toLowerCase(), id: nm[2] };
    }

    const drawerSelectors = [
      '[data-test="detailsDrawer"]',
      '[data-test*="Drawer"]',
      '[data-test*="drawer"]',
      '[data-test*="Preview"]',
      '[data-test*="preview"]',
      '[role="dialog"]',
      '[aria-modal="true"]'
    ];
    const drawers = document.querySelectorAll(drawerSelectors.join(', '));
    for (const drawer of drawers) {
      const link = drawer.querySelector(
        'a[href*="/deal/"], a[href*="/person/"], a[href*="/leads/"], a[href*="/organization/"]'
      );
      if (link) {
        const dm = link.getAttribute('href').match(ENTITY_LINK_RE);
        if (dm) return { kind: dm[1].toLowerCase(), id: dm[2] };
      }
    }
    return null;
  }

  // Detect selected entities (deals/persons/leads/organizations) on Pipedrive
  // list views. Pipedrive varies its DOM, so we use multiple strategies and
  // always require at least 2 selected rows to show the mass button.
  function detectSelectedEntities() {
    const entities = [];
    const seen = new Set();

    // Strategy: walk checked checkboxes; find the nearest ancestor that
    // carries an entity id (data-id / data-test-id) or contains an internal
    // link matching /(deal|person|leads|organization)/:id.
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:checked');

    // Infer kind from current pathname if rows don't carry it.
    const pathKindMatch = window.location.pathname.match(/\/(deal|person|lead|organization)s?\b/);
    const fallbackKind = pathKindMatch ? (pathKindMatch[1] === 'lead' ? 'leads' : pathKindMatch[1]) : null;

    checkboxes.forEach(cb => {
      // Skip obvious "select all" checkboxes (usually in thead)
      if (cb.closest('thead')) return;

      const row = cb.closest('[data-id], [data-test-id], [data-test="list-row"], tr, li, .list-row, [class*="Row"]');
      if (!row) return;

      let kind = null, id = null;

      const link = row.querySelector('a[href*="/deal/"], a[href*="/person/"], a[href*="/leads/"], a[href*="/organization/"]');
      if (link) {
        const m = link.getAttribute('href').match(/\/(deal|person|leads|organization)\/([\w-]+)/);
        if (m) { kind = m[1]; id = m[2]; }
      }

      if (!id) {
        const rawId = row.getAttribute('data-id') || row.getAttribute('data-test-id');
        if (rawId && /^\d+$/.test(String(rawId))) {
          id = rawId;
          kind = fallbackKind;
        }
      }

      if (!kind || !id) return;
      const key = `${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      entities.push({ kind, id });
    });

    return entities;
  }

  function setSelectionButton(entities) {
    const fab = document.getElementById('whatpipe-fab');
    if (!fab) return;
    let btn = fab.querySelector('#whatpipe-fab-mass');
    if (entities.length < 2) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'whatpipe-fab-mass';
      btn.className = 'whatpipe-fab-btn whatpipe-fab-btn-secondary';
      btn.title = 'Enviar a los contactos seleccionados';
      fab.insertBefore(btn, fab.firstChild); // show above the main send btn
      btn.addEventListener('click', () => openMassModal(btn._entities || []));
    }
    btn._entities = entities;
    btn.innerHTML = `
      <span class="fab-icon">📋</span>
      <span class="fab-text">Enviar a ${entities.length}</span>
    `;
  }

  let selectionIntervalId = null;
  let selectionLastSig = '';
  function watchSelection() {
    const tick = () => {
      const entities = detectSelectedEntities();
      const sig = entities.map(e => `${e.kind}:${e.id}`).sort().join(',');
      if (sig !== selectionLastSig) {
        selectionLastSig = sig;
        setSelectionButton(entities);
      }
    };
    tick();
    if (selectionIntervalId) return; // already running
    // Pipedrive is an SPA with heavy re-renders; poll lightly.
    selectionIntervalId = setInterval(tick, 800);
  }

  // Normalize a phone to E.164-ish digits with country code prepended when missing.
  // Rules:
  //  - strip all non-digits (and a leading + if present)
  //  - if the number is 10 digits and a country code is set, prepend it
  //  - if it starts with 0 and has 11 digits, drop the 0 and prepend country code
  //  - otherwise return as-is (assume user already included country code)
  function normalizePhoneNumber(raw, countryCode) {
    const digitsOnly = String(raw || '').replace(/[^0-9]/g, '');
    if (!digitsOnly) return '';
    const cc = String(countryCode || '').replace(/[^0-9]/g, '');
    if (!cc) return digitsOnly;
    if (digitsOnly.startsWith(cc) && digitsOnly.length >= 11) return digitsOnly;
    if (digitsOnly.length === 10) return cc + digitsOnly;
    if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) return cc + digitsOnly.slice(1);
    return digitsOnly;
  }

  async function getSettings() {
    const resp = await chrome.runtime.sendMessage({ action: 'getSettings' });
    return (resp && resp.success && resp.settings) || {};
  }

  // Detect phone numbers on the page (tel: links + regex)
  function detectPhoneNumbers() {
    const phones = new Set();

    // 1. Look for tel: links (most reliable)
    document.querySelectorAll('a[href^="tel:"]').forEach(link => {
      let num = link.getAttribute('href').replace('tel:', '').trim();
      num = num.replace(/[^0-9+]/g, '');
      if (num.length >= 8) {
        phones.add(num.replace(/^\+/, '')); // Remove leading + for Whaticket format
      }
    });

    // 2. Regex search in visible text (for numbers not in links)
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    // Require leading + or a parenthesised country code to avoid matching CNPJs, IDs, dates.
    const phoneRegex = /(?:\+\d{1,4}[-.\s]?|\(\+?\d{1,4}\)[-.\s]?)\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      const matches = text.match(phoneRegex);
      if (matches) {
        matches.forEach(m => {
          const clean = m.replace(/[^0-9]/g, '');
          if (clean.length >= 10 && clean.length <= 15) {
            phones.add(clean);
          }
        });
      }
    }

    return Array.from(phones);
  }

  // Words that indicate a section/list page, not an entity. Lowercase, no accents.
  const SECTION_BLACKLIST = new Set([
    'negocios', 'deals', 'contactos', 'contacts', 'personas', 'people',
    'leads', 'prospectos', 'organizaciones', 'organizations', 'empresas',
    'actividades', 'activities', 'bandeja', 'inbox', 'mail', 'correo',
    'proyectos', 'projects', 'productos', 'products', 'informes', 'reports',
    'pipedrive', 'configuracion', 'configuración', 'settings', 'campañas', 'campanas'
  ]);

  function normalize(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim();
  }

  function isValidEntityName(txt) {
    if (!txt) return false;
    const trimmed = txt.trim();
    if (trimmed.length < 2 || trimmed.length > 120) return false;
    const norm = normalize(trimmed);
    if (SECTION_BLACKLIST.has(norm)) return false;
    // Reject if the whole string is a single blacklisted word even with extras like "Negocios (12)"
    const firstWord = norm.split(/[\s(]/)[0];
    if (SECTION_BLACKLIST.has(firstWord)) return false;
    return true;
  }

  // Best-effort extraction of contact context (name, company) from Pipedrive page.
  function detectContext() {
    const ctx = { nombre: '', empresa: '' };

    // 1) document.title — usually "Entity Name - Pipedrive"
    let candidate = '';
    const rawTitle = (document.title || '').trim();
    if (rawTitle) {
      const cleaned = rawTitle
        .replace(/\s*[-–|]\s*Pipedrive.*$/i, '')
        .replace(/^\(\d+\)\s*/, '') // strip notification count like "(3) "
        .trim();
      if (isValidEntityName(cleaned)) candidate = cleaned;
    }

    // 2) Specific Pipedrive selectors (more reliable than h1)
    if (!candidate) {
      const nameSelectors = [
        '[data-test="entity-name"]',
        '[data-test="person-name"]',
        '[data-test="deal-title"]',
        '[data-test="deal-details-title"]',
        '[data-test="lead-title"]',
        '[data-test="detailsDrawer"] [data-test*="title"]',
        '[data-test="detailsDrawer"] [data-test*="name"]',
        '.detailHeader__title',
        '.entityDetail__title'
      ];
      for (const sel of nameSelectors) {
        const el = document.querySelector(sel);
        const txt = el && el.textContent ? el.textContent.trim() : '';
        if (isValidEntityName(txt)) { candidate = txt; break; }
      }
    }

    // 3) Fallback: h1, but validated against blacklist
    if (!candidate) {
      const h1s = document.querySelectorAll('h1');
      for (const el of h1s) {
        const txt = (el.textContent || '').trim();
        if (isValidEntityName(txt)) { candidate = txt; break; }
      }
    }

    if (candidate) {
      ctx.nombre = candidate.split(/\s+/)[0];
    }

    // Organization / company
    const orgSelectors = [
      '[data-test="organization-name"]',
      '[data-test="org-name"]',
      '[data-test="detailsDrawer"] a[href*="/organization/"]',
      'a[href*="/organization/"]'
    ];
    for (const sel of orgSelectors) {
      const el = document.querySelector(sel);
      const txt = el && el.textContent ? el.textContent.trim() : '';
      if (isValidEntityName(txt)) { ctx.empresa = txt; break; }
    }

    return ctx;
  }

  // Supported template variables:
  // {{nombre}} {{apellido}} {{nombre_completo}} {{empresa}} {{email}}
  // {{deal}} {{etapa}} {{owner}} {{mi_empresa}}
  function renderTemplate(body, vars) {
    const v = vars || {};
    return String(body || '').replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, key) => {
      const k = key.toLowerCase();
      return (k in v && v[k] != null) ? String(v[k]) : '';
    });
  }

  // Make a modal draggable from its header. On first drag the overlay is
  // turned transparent + click-through so the user can read/interact with
  // the page underneath while keeping the modal available.
  function makeModalDraggable(modal) {
    const header = modal.querySelector('.whatpipe-modal-header');
    const content = modal.querySelector('.whatpipe-modal-content');
    const overlay = modal.querySelector('.whatpipe-modal-overlay');
    if (!header || !content || !overlay) return;

    header.style.cursor = 'move';
    header.style.userSelect = 'none';
    header.title = 'Arrastrá para mover';

    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
    let dragging = false, detached = false;

    const onDown = (e) => {
      if (e.target.closest('button')) return; // don't start drag on close/send buttons
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      dragging = true;

      if (!detached) {
        const rect = content.getBoundingClientRect();
        overlay.style.background = 'transparent';
        overlay.style.pointerEvents = 'none';
        content.style.pointerEvents = 'auto';
        content.style.position = 'fixed';
        content.style.left = rect.left + 'px';
        content.style.top = rect.top + 'px';
        content.style.margin = '0';
        content.style.animation = 'none';
        detached = true;
      }
      startX = e.clientX; startY = e.clientY;
      origLeft = parseFloat(content.style.left) || 0;
      origTop = parseFloat(content.style.top) || 0;
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let nextLeft = origLeft + dx;
      let nextTop = origTop + dy;
      // Clamp so the header stays on screen
      const w = content.offsetWidth;
      const h = content.offsetHeight;
      nextLeft = Math.max(-w + 80, Math.min(window.innerWidth - 80, nextLeft));
      nextTop = Math.max(0, Math.min(window.innerHeight - 60, nextTop));
      content.style.left = nextLeft + 'px';
      content.style.top = nextTop + 'px';
    };

    const onUp = () => { dragging = false; };

    header.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // In-memory cache for Pipedrive API lookups (per tab, invalidated after 60s
  // or on URL change so users get fresh data when they navigate).
  const pdCache = new Map();
  function getCachedLookup(url) {
    const entry = pdCache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.at > 60_000) { pdCache.delete(url); return null; }
    return entry.value;
  }

  // Create and open the send modal. Optionally pre-fill with a specific
  // phone (used by the inline-icon mode to target the clicked number).
  function openSendModal(prefillPhone) {
    // Remove existing modal
    const existingModal = document.getElementById('whatpipe-modal');
    if (existingModal) existingModal.remove();

    const detectedPhones = detectPhoneNumbers();
    const defaultPhone = prefillPhone
      ? String(prefillPhone).replace(/^\+/, '')
      : (detectedPhones.length > 0 ? detectedPhones[0] : '');

    const modal = document.createElement('div');
    modal.id = 'whatpipe-modal';
    modal.innerHTML = `
      <div class="whatpipe-modal-overlay">
        <div class="whatpipe-modal-content">
          <div class="whatpipe-modal-header">
            <h2>📱 Enviar mensaje por WhatsApp</h2>
            <button class="whatpipe-close-btn" title="Cerrar">✕</button>
          </div>

          <div class="whatpipe-modal-body">
            <div id="whatpipe-entity-chip" class="whatpipe-entity-chip" style="display:none;"></div>

            <div class="whatpipe-form-group">
              <label>Número de teléfono (WhatsApp)</label>
              <div class="whatpipe-number-row">
                <input type="text" id="whatpipe-number" placeholder="5513991113966" />
              </div>
              <small class="whatpipe-hint">Formato internacional sin + (ej: 5513991113966)</small>
            </div>

            <div class="whatpipe-form-group">
              <label>Plantilla</label>
              <div class="whatpipe-tpl-row">
                <select id="whatpipe-template">
                  <option value="">— Escribir mensaje libre —</option>
                </select>
                <button type="button" class="whatpipe-link-btn" id="whatpipe-save-tpl">💾 Guardar como plantilla</button>
              </div>
            </div>

            <div class="whatpipe-form-group whatpipe-vars">
              <label style="font-size:13px; color:#64748b; display:flex; align-items:center; gap:8px;">
                <span>Variables detectadas (editables)</span>
                <span id="whatpipe-source-badge" class="whatpipe-source-badge" style="display:none;"></span>
              </label>
              <div class="whatpipe-vars-row">
                <input type="text" id="whatpipe-var-nombre" placeholder="Nombre" />
                <input type="text" id="whatpipe-var-empresa" placeholder="Mi Empresa" />
              </div>
              <div id="whatpipe-extra-vars" class="whatpipe-extra-vars" style="display:none;"></div>
            </div>

            <div class="whatpipe-form-group">
              <label>Mensaje</label>
              <textarea id="whatpipe-message" rows="6" placeholder="Hola! Te contacto desde Pipedrive..."></textarea>
            </div>

            <div class="whatpipe-form-group">
              <label>Conexión de WhatsApp</label>
              <select id="whatpipe-connection">
                <option value="">Cargando conexiones...</option>
              </select>
              <small class="whatpipe-hint">Selecciona la conexión desde la que enviarás el mensaje</small>
            </div>
          </div>

          <div class="whatpipe-modal-footer">
            <button class="whatpipe-btn whatpipe-btn-secondary" id="whatpipe-cancel">Cancelar</button>
            <button class="whatpipe-btn whatpipe-btn-primary" id="whatpipe-send">
              <span class="btn-text">Enviar mensaje</span>
              <span class="btn-spinner" style="display:none;">⏳</span>
            </button>
          </div>

          <div id="whatpipe-status" class="whatpipe-status"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Safely set default phone value
    modal.querySelector('#whatpipe-number').value = defaultPhone;

    // If multiple phones detected, build select safely with createElement
    if (detectedPhones.length > 1) {
      const numberRow = modal.querySelector('.whatpipe-number-row');
      const phoneSelect = document.createElement('select');
      phoneSelect.id = 'whatpipe-phone-select';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Seleccionar detectado...';
      phoneSelect.appendChild(placeholder);
      detectedPhones.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        phoneSelect.appendChild(opt);
      });
      numberRow.appendChild(phoneSelect);
    }

    makeModalDraggable(modal);

    // Prefill variables from detected context (DOM). "Empresa" field defaults
    // to the user's own configured company (senderCompany), not the contact's.
    const ctx = detectContext();
    modal.querySelector('#whatpipe-var-nombre').value = ctx.nombre;
    chrome.storage.local.get(['senderCompany'], ({ senderCompany }) => {
      const empresaInput = modal.querySelector('#whatpipe-var-empresa');
      if (empresaInput && !empresaInput.value) {
        empresaInput.value = senderCompany || '';
      }
      modal._settings = Object.assign({}, modal._settings || {}, { senderCompany: senderCompany || '' });
      if (typeof modal._applyTemplate === 'function') modal._applyTemplate();
    });

    // Setup events
    setupModalEvents(modal, detectedPhones);

    // Load connections and templates
    loadConnectionsIntoSelect(modal);
    loadTemplatesIntoSelect(modal);

    // Enrich from Pipedrive API if configured — overrides DOM guesses.
    enrichFromPipedriveAPI(modal);

    // Entity chip: mostrar si detectamos deal/lead/persona/org para la nota.
    renderEntityChip(modal);
    // Refrescar periódicamente mientras el modal está abierto — la preview
    // puede abrirse o cambiar después de abrir el modal.
    const entityChipInterval = setInterval(() => {
      if (!document.body.contains(modal)) {
        clearInterval(entityChipInterval);
        return;
      }
      renderEntityChip(modal);
    }, 1500);

    // Save-as-template button
    modal.querySelector('#whatpipe-save-tpl').addEventListener('click', () => saveCurrentAsTemplate(modal));
  }

  // Normalize the Pipedrive response into a flat context object and list of
  // labeled phones. Handles person / deal / lead / organization shapes.
  function normalizePipedrivePayload(payload) {
    const ctx = {
      nombre: '', apellido: '', nombre_completo: '',
      empresa: '', email: '', deal: '', etapa: '', owner: ''
    };
    const phones = []; // [{ value, label }]

    if (!payload) return { ctx, phones };
    const { kind, data, person, organization } = payload;
    if (!data) return { ctx, phones };

    const setNameFrom = (full) => {
      if (!full) return;
      const str = String(full).trim();
      ctx.nombre_completo = str;
      const parts = str.split(/\s+/);
      ctx.nombre = parts[0] || '';
      ctx.apellido = parts.slice(1).join(' ');
    };
    const collectPhones = (arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach(p => {
        if (p && p.value) phones.push({ value: String(p.value), label: p.label || '' });
      });
    };
    const collectEmail = (arr) => {
      if (Array.isArray(arr) && arr[0] && arr[0].value) ctx.email = arr[0].value;
      else if (typeof arr === 'string') ctx.email = arr;
    };

    if (kind === 'person') {
      setNameFrom(data.name);
      collectPhones(data.phone);
      collectEmail(data.email);
      if (data.org_id && data.org_id.name) ctx.empresa = data.org_id.name;
      if (data.owner_id && data.owner_id.name) ctx.owner = data.owner_id.name;
    } else if (kind === 'deal') {
      if (data.person_id) {
        setNameFrom(data.person_id.name);
        collectPhones(data.person_id.phone);
        collectEmail(data.person_id.email);
      }
      if (data.org_id && data.org_id.name) ctx.empresa = data.org_id.name;
      if (data.title) ctx.deal = data.title;
      if (data.stage_name) ctx.etapa = data.stage_name; // deal list endpoint exposes stage_name; detail may not
      if (data.user_id && data.user_id.name) ctx.owner = data.user_id.name;
    } else if (kind === 'organization') {
      if (data.name) ctx.empresa = data.name;
      if (data.owner_id && data.owner_id.name) ctx.owner = data.owner_id.name;
    } else if (kind === 'leads') {
      if (data.title && !person) setNameFrom(data.title);
      if (person) {
        setNameFrom(person.name);
        collectPhones(person.phone);
        collectEmail(person.email);
      }
      if (organization && organization.name) ctx.empresa = organization.name;
      if (data.owner_id && typeof data.owner_id === 'object' && data.owner_id.name) ctx.owner = data.owner_id.name;
    }

    // Rank phones: prefer WhatsApp/mobile/móvil label over others.
    const labelScore = (lbl) => {
      const l = String(lbl || '').toLowerCase();
      if (/whats|wa|wsp/.test(l)) return 0;
      if (/mobile|móvil|movil|cel|celular/.test(l)) return 1;
      if (/work|trabajo|oficina/.test(l)) return 2;
      return 3;
    };
    phones.sort((a, b) => labelScore(a.label) - labelScore(b.label));

    return { ctx, phones };
  }

  async function enrichFromPipedriveAPI(modal) {
    const url = window.location.href;
    setSourceBadge(modal, 'pending');

    // Try cache first
    let payload = getCachedLookup(url);
    if (!payload) {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'pipedriveLookup', url });
        if (!resp || !resp.success) {
          // Token missing or API error → just keep DOM-based context.
          setSourceBadge(modal, 'dom');
          return;
        }
        payload = resp.data; // may be null if URL doesn't match an entity
        if (payload) pdCache.set(url, { at: Date.now(), value: payload });
      } catch (err) {
        console.debug('[WhatPipe] Pipedrive API lookup error:', err.message);
        setSourceBadge(modal, 'dom');
        return;
      }
    }

    if (!payload || !payload.data) {
      setSourceBadge(modal, 'dom');
      return;
    }

    const { ctx, phones } = normalizePipedrivePayload(payload);

    const nombreInput = modal.querySelector('#whatpipe-var-nombre');
    const empresaInput = modal.querySelector('#whatpipe-var-empresa');
    const numberInput = modal.querySelector('#whatpipe-number');
    const numberRow = modal.querySelector('.whatpipe-number-row');

    if (ctx.nombre) nombreInput.value = ctx.nombre;
    // Don't overwrite empresa: the user prefers the field defaulting to their
    // own company (senderCompany). They can edit it manually if they want the
    // contact's organization instead.

    // Replace phone selector with labeled options from Pipedrive.
    if (phones.length) {
      let select = modal.querySelector('#whatpipe-phone-select');
      if (!select) {
        select = document.createElement('select');
        select.id = 'whatpipe-phone-select';
        numberRow.appendChild(select);
        select.addEventListener('change', () => {
          if (select.value) numberInput.value = select.value.replace(/[^0-9]/g, '');
        });
      } else {
        select.innerHTML = '';
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `${phones.length} teléfono${phones.length === 1 ? '' : 's'} de Pipedrive…`;
      select.appendChild(placeholder);
      phones.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.label ? `${p.value} · ${p.label}` : p.value;
        select.appendChild(opt);
      });

      // Auto-pick the top-ranked phone if the number field is empty.
      if (!numberInput.value) {
        const top = phones[0].value.replace(/[^0-9]/g, '');
        if (top.length >= 8) {
          numberInput.value = top;
          select.value = phones[0].value;
        }
      }
    }

    // Persist context and update extra-vars panel for templates
    modal._pdContext = ctx;
    renderExtraVars(modal, ctx);
    setSourceBadge(modal, 'pipedrive');

    if (typeof modal._applyTemplate === 'function') modal._applyTemplate();
  }

  // Visual badge showing data source (pipedrive / dom / loading).
  function setSourceBadge(modal, source) {
    const badge = modal.querySelector('#whatpipe-source-badge');
    if (!badge) return;
    const map = {
      pending: { text: 'Consultando Pipedrive…', cls: 'pending' },
      pipedrive: { text: '✓ Datos de Pipedrive API', cls: 'pipedrive' },
      dom: { text: 'Detectado desde la página', cls: 'dom' }
    };
    const s = map[source] || map.dom;
    badge.textContent = s.text;
    badge.className = 'whatpipe-source-badge ' + s.cls;
    badge.style.display = 'inline-block';
  }

  // Render a small read-only panel with the extra variables picked up from
  // Pipedrive so the user knows which ones can be referenced in templates.
  function renderExtraVars(modal, ctx) {
    const extras = modal.querySelector('#whatpipe-extra-vars');
    if (!extras) return;
    const pairs = [
      ['apellido', ctx.apellido],
      ['email', ctx.email],
      ['deal', ctx.deal],
      ['owner', ctx.owner]
    ].filter(([, v]) => !!v);
    if (!pairs.length) { extras.style.display = 'none'; return; }
    extras.innerHTML = '';
    pairs.forEach(([k, v]) => {
      const chip = document.createElement('span');
      chip.className = 'whatpipe-var-chip';
      chip.textContent = `{{${k}}} · ${v}`;
      extras.appendChild(chip);
    });
    extras.style.display = 'flex';
  }

  // In-page dialog helpers — avoid native prompt()/confirm() which block the
  // whole tab and are being deprecated by Chrome in untrusted contexts.
  function openDialog({ title, message, placeholder, withInput, okText = 'Aceptar', cancelText = 'Cancelar' }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'whatpipe-dialog';
      wrap.innerHTML = `
        <div class="whatpipe-dialog-overlay">
          <div class="whatpipe-dialog-content">
            <h3 class="whatpipe-dialog-title"></h3>
            <p class="whatpipe-dialog-msg" style="display:none;"></p>
            <input type="text" class="whatpipe-dialog-input" style="display:none;" />
            <div class="whatpipe-dialog-actions">
              <button type="button" class="whatpipe-btn whatpipe-btn-secondary" data-act="cancel"></button>
              <button type="button" class="whatpipe-btn whatpipe-btn-primary" data-act="ok"></button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
      wrap.querySelector('.whatpipe-dialog-title').textContent = title || '';
      const msgEl = wrap.querySelector('.whatpipe-dialog-msg');
      if (message) { msgEl.textContent = message; msgEl.style.display = 'block'; }
      const input = wrap.querySelector('.whatpipe-dialog-input');
      if (withInput) {
        input.style.display = 'block';
        input.placeholder = placeholder || '';
        setTimeout(() => input.focus(), 0);
      }
      wrap.querySelector('[data-act="ok"]').textContent = okText;
      wrap.querySelector('[data-act="cancel"]').textContent = cancelText;

      const close = (val) => { wrap.remove(); resolve(val); };
      wrap.querySelector('[data-act="ok"]').addEventListener('click', () => {
        close(withInput ? input.value.trim() : true);
      });
      wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => close(withInput ? null : false));
      wrap.querySelector('.whatpipe-dialog-overlay').addEventListener('click', (e) => {
        if (e.target.classList.contains('whatpipe-dialog-overlay')) close(withInput ? null : false);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); }
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
    });
  }

  async function saveCurrentAsTemplate(modal) {
    const body = modal.querySelector('#whatpipe-message').value.trim();
    if (!body) {
      showStatus(modal.querySelector('#whatpipe-status'), 'Escribe el mensaje primero', 'error');
      return;
    }
    const name = await openDialog({
      title: 'Guardar plantilla',
      message: 'Nombre de la plantilla:',
      withInput: true,
      placeholder: 'Ej: Recontacto cliente',
      okText: 'Guardar'
    });
    if (!name) return;
    const { whatpipeTemplates } = await new Promise(res => chrome.storage.local.get(['whatpipeTemplates'], res));
    const templates = Array.isArray(whatpipeTemplates) ? whatpipeTemplates : [];
    templates.push({ id: `t-${Date.now()}`, name, body, mediaUrl: '' });
    chrome.storage.local.set({ whatpipeTemplates: templates });
    showStatus(modal.querySelector('#whatpipe-status'), '✅ Plantilla guardada', 'success');
  }

  async function loadTemplatesIntoSelect(modal) {
    const select = modal.querySelector('#whatpipe-template');
    const textarea = modal.querySelector('#whatpipe-message');
    const nombreInput = modal.querySelector('#whatpipe-var-nombre');
    const empresaInput = modal.querySelector('#whatpipe-var-empresa');

    // Cache templates on the modal so storage-change handler can reuse them.
    modal._templates = [];

    const rebuildOptions = (templates) => {
      const prev = select.value;
      select.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— Escribir mensaje libre —';
      select.appendChild(placeholder);
      templates.forEach(tpl => {
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.name;
        select.appendChild(opt);
      });
      // Preserve selection if still present
      if (prev && templates.some(t => t.id === prev)) {
        select.value = prev;
      }
      modal._templates = templates;
    };

    const applyTemplate = () => {
      const id = select.value;
      modal._currentMediaUrl = '';
      if (!id) return;
      const tpl = modal._templates.find(t => t.id === id);
      if (!tpl) return;
      const pdCtx = modal._pdContext || {};
      const senderCompany = (modal._settings && modal._settings.senderCompany) || '';
      const myCompany = empresaInput.value.trim() || senderCompany;
      const vars = {
        ...pdCtx,
        // Editable fields always win over Pipedrive values
        nombre: nombreInput.value.trim() || pdCtx.nombre || '',
        // The "Mi Empresa" field feeds both {{mi_empresa}} and legacy {{empresa}}
        empresa: myCompany,
        mi_empresa: myCompany
      };
      if (!vars.nombre_completo && (vars.nombre || vars.apellido)) {
        vars.nombre_completo = `${vars.nombre} ${vars.apellido || ''}`.trim();
      }
      textarea.value = renderTemplate(tpl.body, vars);
      modal._currentMediaUrl = tpl.mediaUrl || '';
    };
    modal._applyTemplate = applyTemplate;

    const { whatpipeTemplates, senderCompany } = await new Promise(resolve => {
      chrome.storage.local.get(['whatpipeTemplates', 'senderCompany'], resolve);
    });
    rebuildOptions(Array.isArray(whatpipeTemplates) ? whatpipeTemplates : []);
    modal._settings = Object.assign({}, modal._settings || {}, { senderCompany: senderCompany || '' });

    modal._rebuildTemplateOptions = rebuildOptions;

    select.addEventListener('change', applyTemplate);
    nombreInput.addEventListener('input', applyTemplate);
    empresaInput.addEventListener('input', applyTemplate);
  }

  // Listen for storage changes so changes in Options reflect live in any open
  // modal across all Pipedrive tabs — no page refresh needed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // UI mode change applies immediately without page reload.
    if (changes.buttonMode) {
      applyUiMode();
    }

    const modal = document.getElementById('whatpipe-modal');
    if (!modal) return;

    if (changes.whatpipeTemplates && typeof modal._rebuildTemplateOptions === 'function') {
      const next = Array.isArray(changes.whatpipeTemplates.newValue)
        ? changes.whatpipeTemplates.newValue
        : [];
      modal._rebuildTemplateOptions(next);
      // If the currently selected template still exists, re-render the textarea
      // so edits to its body propagate immediately.
      if (typeof modal._applyTemplate === 'function') modal._applyTemplate();
    }

    // Token or default connection changed → reload connection list.
    if (changes.whatpipeToken || changes.defaultConnectionId) {
      loadConnectionsIntoSelect(modal);
    }
  });

  function setupModalEvents(modal, detectedPhones) {
    const closeBtn = modal.querySelector('.whatpipe-close-btn');
    const cancelBtn = modal.querySelector('#whatpipe-cancel');
    const sendBtn = modal.querySelector('#whatpipe-send');
    const numberInput = modal.querySelector('#whatpipe-number');
    const phoneSelect = modal.querySelector('#whatpipe-phone-select');
    const connectionSelect = modal.querySelector('#whatpipe-connection');
    const statusDiv = modal.querySelector('#whatpipe-status');

    // Close handlers
    const closeModal = () => modal.remove();
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.querySelector('.whatpipe-modal-overlay').addEventListener('click', (e) => {
      if (e.target === modal.querySelector('.whatpipe-modal-overlay')) closeModal();
    });

    // Phone select change
    if (phoneSelect) {
      phoneSelect.addEventListener('change', () => {
        if (phoneSelect.value) {
          numberInput.value = phoneSelect.value;
        }
      });
    }

    // Send handler
    sendBtn.addEventListener('click', async () => {
      const rawNumber = numberInput.value.trim();
      const body = modal.querySelector('#whatpipe-message').value.trim();
      const connectionId = connectionSelect.value;

      if (!rawNumber) {
        showStatus(statusDiv, 'Por favor ingresa un número de teléfono', 'error');
        return;
      }
      if (!body) {
        showStatus(statusDiv, 'Por favor escribe un mensaje', 'error');
        return;
      }
      if (!connectionId) {
        showStatus(statusDiv, 'Por favor selecciona una conexión', 'error');
        return;
      }

      // Apply default country code if configured
      const settings = await getSettings();
      const number = normalizePhoneNumber(rawNumber, settings.defaultCountryCode);
      if (number.length < 10) {
        showStatus(statusDiv, 'Número inválido. Debe incluir código de país (al menos 10 dígitos).', 'error');
        return;
      }

      // Loading state
      sendBtn.disabled = true;
      sendBtn.querySelector('.btn-text').style.display = 'none';
      sendBtn.querySelector('.btn-spinner').style.display = 'inline';

      try {
        const response = await chrome.runtime.sendMessage({
          action: "sendMessage",
          number: number,
          body: body,
          connectionId: connectionId,
          mediaUrl: modal._currentMediaUrl || '',
          pipedriveEntity: detectCurrentEntity(),
          pageUrl: location.href
        });

        if (response.success) {
          showStatus(statusDiv, '✅ Mensaje enviado correctamente!', 'success');
          setTimeout(() => {
            modal.remove();
            // Optional: show a small success toast
            showToast('Mensaje enviado por WhatPipe');
          }, 1500);
        } else {
          showStatus(statusDiv, '❌ Error: ' + (response.error || 'Desconocido'), 'error');
          sendBtn.disabled = false;
          sendBtn.querySelector('.btn-text').style.display = 'inline';
          sendBtn.querySelector('.btn-spinner').style.display = 'none';
        }
      } catch (error) {
        showStatus(statusDiv, '❌ Error: ' + error.message, 'error');
        sendBtn.disabled = false;
        sendBtn.querySelector('.btn-text').style.display = 'inline';
        sendBtn.querySelector('.btn-spinner').style.display = 'none';
      }
    });
  }

  async function loadConnectionsIntoSelect(modal) {
    const select = modal.querySelector('#whatpipe-connection');
    const statusDiv = modal.querySelector('#whatpipe-status');

    try {
      const [response, settingsResp] = await Promise.all([
        chrome.runtime.sendMessage({ action: "getConnections" }),
        chrome.runtime.sendMessage({ action: "getSettings" })
      ]);

      if (response && response.success && response.connections && response.connections.length > 0) {
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Selecciona una conexión...';
        select.appendChild(placeholder);

        response.connections.forEach(conn => {
          const option = document.createElement('option');
          option.value = conn.id;
          option.textContent = `${conn.name} (${conn.status || 'Activo'})`;
          if (conn.status === 'CONNECTED') {
            option.style.color = '#25D366';
          }
          select.appendChild(option);
        });

        // Cache settings on the modal so templates can read {{mi_empresa}} etc.
        if (settingsResp && settingsResp.success && settingsResp.settings) {
          modal._settings = settingsResp.settings;
        }

        // Priority: saved default > first CONNECTED > first
        const defaultId = settingsResp && settingsResp.success && settingsResp.settings
          ? settingsResp.settings.defaultConnectionId
          : null;
        const hasDefault = defaultId && response.connections.some(c => String(c.id) === String(defaultId));
        if (hasDefault) {
          select.value = defaultId;
        } else {
          const connected = response.connections.find(c => c.status === 'CONNECTED');
          select.value = connected ? connected.id : response.connections[0].id;
        }
      } else {
        select.innerHTML = '<option value="">No se encontraron conexiones</option>';
        showStatus(statusDiv, 'No se pudieron cargar las conexiones. Verifica tu token en Opciones.', 'error');
      }
    } catch (error) {
      select.innerHTML = '<option value="">Error al cargar</option>';
      showStatus(statusDiv, 'Error al cargar conexiones: ' + error.message, 'error');
    }
  }

  function showStatus(element, message, type) {
    element.textContent = message;
    element.className = `whatpipe-status ${type}`;
    element.style.display = 'block';
    
    if (type === 'success') {
      setTimeout(() => {
        element.style.display = 'none';
      }, 3000);
    }
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'whatpipe-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // ---------- Mass send ----------
  // Opens the mass modal pre-loaded with recipients resolved from the
  // Pipedrive entities the user selected on the list view. Requires the
  // Pipedrive API token to be configured (otherwise we can't fetch phones).
  async function openMassModal(entities) {
    if (!Array.isArray(entities) || entities.length < 2) return;

    const existing = document.getElementById('whatpipe-mass-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'whatpipe-mass-modal';
    modal.innerHTML = `
      <div class="whatpipe-modal-overlay">
        <div class="whatpipe-modal-content">
          <div class="whatpipe-modal-header">
            <h2>📋 Envío masivo · ${entities.length} seleccionados</h2>
            <button class="whatpipe-close-btn" title="Cerrar">✕</button>
          </div>

          <div class="whatpipe-modal-body">
            <div class="whatpipe-form-group">
              <label>Destinatarios</label>
              <div id="whatpipe-mass-recipients" class="whatpipe-recipients">
                <div class="whatpipe-hint" style="padding:8px;">Resolviendo datos desde Pipedrive…</div>
              </div>
              <small class="whatpipe-hint">Cada mensaje se renderea con las variables del contacto correspondiente.</small>
            </div>

            <div class="whatpipe-form-group">
              <label>Plantilla (obligatoria)</label>
              <select id="whatpipe-mass-template">
                <option value="">Selecciona una plantilla...</option>
              </select>
              <small class="whatpipe-hint">Variables disponibles: <code>{{nombre}}</code>, <code>{{empresa}}</code>, <code>{{mi_empresa}}</code>, <code>{{email}}</code>, <code>{{deal}}</code>, <code>{{owner}}</code>.</small>
            </div>

            <div class="whatpipe-form-group">
              <label>Conexión</label>
              <select id="whatpipe-mass-connection"><option value="">Cargando…</option></select>
            </div>

            <div class="whatpipe-form-group">
              <label>Intervalo entre mensajes (segundos)</label>
              <input type="number" id="whatpipe-mass-interval" min="3" max="120" value="8" />
              <small class="whatpipe-hint">Recomendado: 5–15 s. Intervalos muy bajos pueden causar bloqueo en WhatsApp.</small>
            </div>

            <div id="whatpipe-mass-log" class="whatpipe-mass-log" style="display:none;"></div>
          </div>

          <div class="whatpipe-modal-footer">
            <button class="whatpipe-btn whatpipe-btn-secondary" id="whatpipe-mass-cancel">Cerrar</button>
            <button class="whatpipe-btn whatpipe-btn-secondary" id="whatpipe-mass-stop" style="display:none;">Detener</button>
            <button class="whatpipe-btn whatpipe-btn-primary" id="whatpipe-mass-start" disabled>
              <span class="btn-text">Iniciar envío</span>
            </button>
          </div>

          <div id="whatpipe-mass-status" class="whatpipe-status"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    makeModalDraggable(modal);

    const recipientsBox = modal.querySelector('#whatpipe-mass-recipients');
    const templateSelect = modal.querySelector('#whatpipe-mass-template');
    const connectionSelect = modal.querySelector('#whatpipe-mass-connection');
    const intervalInput = modal.querySelector('#whatpipe-mass-interval');
    const startBtn = modal.querySelector('#whatpipe-mass-start');
    const stopBtn = modal.querySelector('#whatpipe-mass-stop');
    const cancelBtn = modal.querySelector('#whatpipe-mass-cancel');
    const closeBtn = modal.querySelector('.whatpipe-close-btn');
    const logEl = modal.querySelector('#whatpipe-mass-log');
    const statusDiv = modal.querySelector('#whatpipe-mass-status');

    let cancelled = false;
    const close = () => modal.remove();
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    modal.querySelector('.whatpipe-modal-overlay').addEventListener('click', (e) => {
      if (e.target === modal.querySelector('.whatpipe-modal-overlay')) close();
    });
    stopBtn.addEventListener('click', () => {
      cancelled = true;
      stopBtn.disabled = true;
      stopBtn.textContent = 'Deteniendo…';
    });

    // Load templates
    chrome.storage.local.get(['whatpipeTemplates'], (result) => {
      const templates = Array.isArray(result.whatpipeTemplates) ? result.whatpipeTemplates : [];
      templates.forEach(tpl => {
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.name;
        templateSelect.appendChild(opt);
      });
      modal._templates = templates;
    });

    // Load connections
    (async () => {
      try {
        const [resp, settingsResp] = await Promise.all([
          chrome.runtime.sendMessage({ action: 'getConnections' }),
          chrome.runtime.sendMessage({ action: 'getSettings' })
        ]);
        if (resp && resp.success && resp.connections) {
          connectionSelect.innerHTML = '';
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = 'Selecciona una conexión...';
          connectionSelect.appendChild(placeholder);
          resp.connections.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.name} (${c.status || 'Activo'})`;
            connectionSelect.appendChild(opt);
          });
          const def = settingsResp && settingsResp.success ? settingsResp.settings.defaultConnectionId : null;
          if (def && resp.connections.some(c => String(c.id) === String(def))) {
            connectionSelect.value = def;
          } else {
            const connected = resp.connections.find(c => c.status === 'CONNECTED');
            if (connected) connectionSelect.value = connected.id;
          }
        } else {
          connectionSelect.innerHTML = '<option value="">No hay conexiones</option>';
        }
      } catch (err) {
        connectionSelect.innerHTML = '<option value="">Error al cargar</option>';
      }
    })();

    const log = (msg, cls) => {
      logEl.style.display = 'block';
      const div = document.createElement('div');
      div.className = 'whatpipe-mass-log-entry whatpipe-mass-log-' + (cls || 'info');
      div.textContent = msg;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    };

    // Resolve each selected entity via the Pipedrive API (small concurrency)
    const host = window.location.hostname;
    const resolved = await resolveRecipients(entities, host);
    modal._recipients = resolved.filter(r => r.include !== false);

    // Render recipients list
    renderRecipientsList(recipientsBox, resolved, (idx, include) => {
      resolved[idx].include = include;
      modal._recipients = resolved.filter(r => r.include !== false);
      const validCount = modal._recipients.filter(r => r.phone).length;
      startBtn.disabled = validCount === 0;
    });

    const validCount = modal._recipients.filter(r => r.phone).length;
    startBtn.disabled = validCount === 0;
    if (!validCount) {
      showStatus(statusDiv, 'Ninguno de los seleccionados tiene teléfono en Pipedrive. Verificá la configuración del token y los datos del contacto.', 'error');
    }

    startBtn.addEventListener('click', async () => {
      const tplId = templateSelect.value;
      const connectionId = connectionSelect.value;
      const intervalSec = Math.max(3, Math.min(120, parseInt(intervalInput.value, 10) || 8));

      if (!tplId) return showStatus(statusDiv, 'Seleccioná una plantilla', 'error');
      if (!connectionId) return showStatus(statusDiv, 'Seleccioná una conexión', 'error');

      const tpl = (modal._templates || []).find(t => t.id === tplId);
      if (!tpl) return showStatus(statusDiv, 'Plantilla no encontrada', 'error');

      const recipients = (modal._recipients || []).filter(r => r.phone);
      if (!recipients.length) return showStatus(statusDiv, 'No hay destinatarios con teléfono', 'error');

      const confirmed = await openDialog({
        title: 'Confirmar envío masivo',
        message: `Se enviarán ${recipients.length} mensaje(s) personalizados con un intervalo de ${intervalSec}s. ¿Continuar?`,
        okText: 'Enviar',
        cancelText: 'Cancelar'
      });
      if (!confirmed) return;

      startBtn.disabled = true;
      startBtn.querySelector('.btn-text').textContent = 'Enviando…';
      stopBtn.style.display = 'inline-block';
      stopBtn.disabled = false;
      stopBtn.textContent = 'Detener';
      templateSelect.disabled = true;
      connectionSelect.disabled = true;
      intervalInput.disabled = true;

      const settings = await getSettings();
      let ok = 0, fail = 0;

      for (let i = 0; i < recipients.length; i++) {
        if (cancelled) { log('⏹ Envío detenido por el usuario.', 'info'); break; }
        const r = recipients[i];
        const num = normalizePhoneNumber(r.phone, settings.defaultCountryCode);
        if (num.length < 10) { fail++; log(`✗ ${r.label}: número inválido (${r.phone})`, 'err'); continue; }

        const vars = {
          ...r.ctx,
          nombre: r.ctx.nombre || '',
          // "empresa" and "mi_empresa" both resolve to the user's company
          empresa: settings.senderCompany || '',
          mi_empresa: settings.senderCompany || ''
        };
        if (!vars.nombre_completo && (vars.nombre || vars.apellido)) {
          vars.nombre_completo = `${vars.nombre} ${vars.apellido || ''}`.trim();
        }
        const body = renderTemplate(tpl.body, vars);

        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'sendMessage',
            number: num,
            body,
            connectionId,
            mediaUrl: tpl.mediaUrl || '',
            pipedriveEntity: (r.kind && r.id) ? { kind: r.kind, id: r.id } : null
          });
          if (resp && resp.success) {
            ok++;
            log(`✓ ${r.label} → ${num} (${i + 1}/${recipients.length})`, 'ok');
          } else {
            fail++;
            log(`✗ ${r.label}: ${resp && resp.error || 'error desconocido'}`, 'err');
          }
        } catch (err) {
          fail++;
          log(`✗ ${r.label}: ${err.message}`, 'err');
        }

        if (i < recipients.length - 1 && !cancelled) {
          await new Promise(res => setTimeout(res, intervalSec * 1000));
        }
      }

      log(`— Finalizado: ${ok} enviados, ${fail} fallidos —`, 'info');
      showStatus(statusDiv, `Enviados: ${ok} · Fallidos: ${fail}`, fail === 0 ? 'success' : 'error');
      startBtn.disabled = false;
      startBtn.querySelector('.btn-text').textContent = 'Iniciar envío';
      stopBtn.style.display = 'none';
      templateSelect.disabled = false;
      connectionSelect.disabled = false;
      intervalInput.disabled = false;
    });
  }

  // Resolve each selected entity via Pipedrive API with bounded concurrency.
  async function resolveRecipients(entities, host) {
    const concurrency = 3;
    const results = new Array(entities.length);
    let cursor = 0;

    const fetchOne = async (idx) => {
      const ent = entities[idx];
      const fakeUrl = `https://${host}/${ent.kind}/${ent.id}`;
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'pipedriveLookup', url: fakeUrl });
        if (!resp || !resp.success || !resp.data) {
          results[idx] = { kind: ent.kind, id: ent.id, phone: '', ctx: {}, label: `${ent.kind} ${ent.id}`, error: resp && resp.error || 'sin datos' };
          return;
        }
        const { ctx, phones } = normalizePipedrivePayload(resp.data);
        const phone = phones[0] ? phones[0].value : '';
        const label = ctx.nombre_completo || ctx.nombre || ctx.empresa || `${ent.kind} ${ent.id}`;
        results[idx] = { kind: ent.kind, id: ent.id, phone, phones, ctx, label };
      } catch (err) {
        results[idx] = { kind: ent.kind, id: ent.id, phone: '', ctx: {}, label: `${ent.kind} ${ent.id}`, error: err.message };
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, entities.length) }, async () => {
      while (cursor < entities.length) {
        const idx = cursor++;
        await fetchOne(idx);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function renderRecipientsList(container, recipients, onToggle) {
    container.innerHTML = '';
    if (!recipients.length) {
      container.innerHTML = '<div class="whatpipe-hint" style="padding:8px;">Sin destinatarios.</div>';
      return;
    }
    recipients.forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'whatpipe-recipient-row';

      const left = document.createElement('label');
      left.className = 'whatpipe-recipient-left';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!r.phone;
      cb.disabled = !r.phone;
      cb.addEventListener('change', () => onToggle(idx, cb.checked));
      const name = document.createElement('span');
      name.className = 'whatpipe-recipient-name';
      name.textContent = r.label;
      left.appendChild(cb);
      left.appendChild(name);

      const right = document.createElement('div');
      right.className = 'whatpipe-recipient-right';
      if (r.phone) {
        const phone = document.createElement('span');
        phone.className = 'whatpipe-recipient-phone';
        phone.textContent = r.phone;
        right.appendChild(phone);
      } else {
        const no = document.createElement('span');
        no.className = 'whatpipe-recipient-no';
        no.textContent = r.error || 'Sin teléfono';
        right.appendChild(no);
      }

      row.appendChild(left);
      row.appendChild(right);
      container.appendChild(row);
      if (!r.phone) r.include = false;
    });
  }

  // ---------- Keyboard shortcut ----------
  // Registered as a chrome.commands entry in the manifest; the background
  // service worker relays the trigger here. Users can remap it from
  // chrome://extensions/shortcuts.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'openSendModal') openSendModal();
  });

  // Initialize
  function init() {
    setTimeout(() => {
      applyUiMode();
      watchSelection();
      installPreviewEntityObserver();
    }, 800);

    // Re-inject on navigation (Pipedrive is SPA)
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          applyUiMode();
          watchSelection();
        }, 1000);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();