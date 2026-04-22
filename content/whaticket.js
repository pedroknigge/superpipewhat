// PipeWhat — content script
// Inyecta un panel lateral en Whaticket con datos del contacto en Pipedrive.

(function () {
  "use strict";

  const PANEL_ID = "pipewhat-panel";
  const PHONE_REGEX = /(?:\+\d{1,4}[-.\s]?|\(\+?\d{1,4}\)[-.\s]?)\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;

  let currentPhone = null;
  let lastLookupAt = 0;
  let cachedSettings = null;
  let contextValid = true;

  // Wrappers seguros para APIs chrome.* que pueden invalidarse cuando la
  // extensión se actualiza o recarga mientras la tab sigue abierta.
  function isContextValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  function markInvalidated() {
    if (!contextValid) return;
    contextValid = false;
    try { if (urlPollId) clearInterval(urlPollId); } catch {}
    try { if (domObs) domObs.disconnect(); } catch {}
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const body = panel.querySelector(".pipewhat-body");
    if (!body) return;
    const banner = document.createElement("div");
    banner.className = "pipewhat-error";
    banner.textContent = "La extensión se actualizó. Recargá la página (F5) para seguir usando PipeWhat.";
    body.replaceChildren(banner);
  }

  function safeSet(obj) {
    if (!isContextValid()) { markInvalidated(); return; }
    try { chrome.storage.local.set(obj); } catch (e) { markInvalidated(); }
  }

  function safeGet(keys) {
    return new Promise((resolve) => {
      if (!isContextValid()) { markInvalidated(); return resolve({}); }
      try {
        chrome.storage.local.get(keys, (s) => resolve(s || {}));
      } catch (e) {
        markInvalidated();
        resolve({});
      }
    });
  }

  async function safeSendMessage(msg) {
    if (!isContextValid()) { markInvalidated(); return null; }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const m = String(e && e.message || e);
      if (/context invalidated|Extension context|receiving end/i.test(m)) markInvalidated();
      return null;
    }
  }

  // Copia texto al portapapeles y muestra feedback en el elemento origen
  function copyToClipboard(text, sourceEl) {
    if (!text) return;
    const done = () => {
      if (!sourceEl) return;
      const orig = sourceEl.getAttribute("data-orig") || sourceEl.textContent;
      if (!sourceEl.getAttribute("data-orig")) sourceEl.setAttribute("data-orig", orig);
      sourceEl.textContent = "✓ copiado";
      sourceEl.classList.add("pipewhat-copied");
      setTimeout(() => {
        sourceEl.textContent = orig;
        sourceEl.classList.remove("pipewhat-copied");
      }, 1100);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
      return;
    }
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch {}
    ta.remove();
  }

  // Escucha el comando toggle-panel del service worker (Alt+Shift+P)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "togglePanel") {
      const panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      const collapsed = panel.classList.toggle("pipewhat-collapsed");
      safeSet({ pipewhatCollapsed: collapsed });
      syncBodyMargin(panel);
      if (!collapsed) refresh();
    }
  });

  async function loadSettings() {
    const resp = await safeSendMessage({ action: "getSettings" });
    cachedSettings = (resp && resp.settings) || {};
    return cachedSettings;
  }

  // ---------- helpers ----------

  function normalizePhone(raw) {
    const digits = String(raw || "").replace(/[^0-9]/g, "");
    if (digits.length < 8 || digits.length > 15) return "";
    return digits;
  }

  function $(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k === "onclick") el.addEventListener("click", attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function formatMoney(value, currency) {
    if (value == null) return "";
    const n = Number(value);
    if (!isFinite(n)) return "";
    try {
      return new Intl.NumberFormat("es-AR", { style: "currency", currency: currency || "ARS", maximumFractionDigits: 0 }).format(n);
    } catch {
      return `${currency || ""} ${n.toLocaleString("es-AR")}`.trim();
    }
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso.replace(" ", "T") + (iso.includes("T") ? "" : "Z"));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // ---------- phone detection ----------

  function detectActivePhone() {
    // 1) URL: /tickets/:id con query o path que contenga número
    const urlDigits = (location.pathname + location.search).match(/\+?\d[\d\s().-]{7,}/g) || [];
    for (const raw of urlDigits) {
      const p = normalizePhone(raw);
      if (p && p.length >= 10) return p;
    }

    // 2) tel: links visibles
    const telLinks = document.querySelectorAll('a[href^="tel:"]');
    for (const a of telLinks) {
      const p = normalizePhone(a.getAttribute("href").replace("tel:", ""));
      if (p && p.length >= 10) return p;
    }

    // 3) Buscar en el header del chat activo. Whaticket (varias variantes) usa elementos
    // con el nombre/número del contacto en la parte superior del chat.
    const headerSelectors = [
      '[class*="TicketHeader"]',
      '[class*="ContactHeader"]',
      '[class*="ChatHeader"]',
      '[class*="conversation-header"]',
      "header",
      '[role="banner"]'
    ];
    for (const sel of headerSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const n of nodes) {
        const txt = (n.innerText || n.textContent || "").slice(0, 500);
        const matches = txt.match(PHONE_REGEX);
        if (matches) {
          for (const m of matches) {
            const p = normalizePhone(m);
            if (p && p.length >= 10) return p;
          }
        }
      }
    }

    return null;
  }

  // ---------- panel UI ----------

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    // Abre por default; el user puede colapsarlo
    panel = $("div", { id: PANEL_ID });

    // Ancho por defecto responsivo:
    //   - nunca menos de 320 (usable en 1366 manteniendo chat respirando)
    //   - nunca más de 440 (cómodo para deals extensos)
    //   - aproximadamente 30% del viewport para que en 1920+ ocupe ~440 y en
    //     1366 ocupe ~400
    const smartDefault = Math.round(
      Math.max(320, Math.min(440, window.innerWidth * 0.30))
    );

    safeGet(["pipewhatWidth", "pipewhatCollapsed"]).then((s) => {
      const w = Number(s.pipewhatWidth);
      if (w && w >= 300 && w <= Math.min(900, window.innerWidth - 50)) {
        panel.style.width = w + "px";
      } else {
        panel.style.width = smartDefault + "px";
      }
      // Decisión de colapsado inicial:
      //   - si el user ya eligió algo, respetarlo
      //   - si no hay preferencia y la pantalla es chica (<1100), arrancar colapsado
      if (s.pipewhatCollapsed != null) {
        if (s.pipewhatCollapsed) panel.classList.add("pipewhat-collapsed");
      } else if (window.innerWidth < 1100) {
        panel.classList.add("pipewhat-collapsed");
      }
      syncBodyMargin(panel);
    });

    const resize = $("div", { class: "pipewhat-resize", title: "Arrastrar para redimensionar" });
    attachResize(panel, resize);

    const toggle = $("button", {
      class: "pipewhat-toggle",
      title: "PipeWhat",
      "aria-label": "Abrir PipeWhat",
      onclick: () => {
        const collapsed = panel.classList.toggle("pipewhat-collapsed");
        safeSet({ pipewhatCollapsed: collapsed });
        syncBodyMargin(panel);
        if (!collapsed) refresh();
      }
    }, "PW");

    const refreshBtn = $("button", {
      class: "pipewhat-icon-btn",
      title: "Refrescar (fuerza recarga del sidebar)",
      "aria-label": "Refrescar",
      onclick: async () => {
        if (!contextValid) { location.reload(); return; }
        refreshBtn.classList.add("pipewhat-spinning");
        try { await refresh(true); } finally {
          setTimeout(() => refreshBtn.classList.remove("pipewhat-spinning"), 300);
        }
      }
    }, "↻");

    const header = $("div", { class: "pipewhat-panel-header" }, [
      $("div", {}, [
        $("h2", { text: "PipeWhat" }),
        $("div", { class: "pipewhat-sub", text: "Pipedrive dentro de Whaticket" })
      ]),
      $("div", { class: "pipewhat-header-actions" }, [
        refreshBtn,
        $("button", {
          class: "pipewhat-icon-btn",
          title: "Colapsar",
          "aria-label": "Colapsar panel",
          onclick: () => {
            panel.classList.add("pipewhat-collapsed");
            safeSet({ pipewhatCollapsed: true });
            syncBodyMargin(panel);
          }
        }, "×")
      ])
    ]);

    const body = $("div", { class: "pipewhat-body" });

    const credit = $("div", { class: "pipewhat-credit" }, [
      "by ",
      $("a", { href: "https://marketingfraccional.com", target: "_blank", rel: "noopener" }, "marketingfraccional.com"),
      " · Pedro Knigge"
    ]);

    panel.append(resize, toggle, header, body, credit);
    document.body.appendChild(panel);
    return panel;
  }

  // Mantiene body.marginRight sincronizado con el ancho del panel abierto
  // para que Whaticket se encoja en vez de quedar tapado.
  // Ancho visible del panel cuando está colapsado (la pestaña PD).
  // Debe coincidir con el translateX de .pipewhat-collapsed en content.css.
  const COLLAPSED_VISIBLE_PX = 46;

  function syncBodyMargin(panel) {
    if (!document.body) return;
    const collapsed = panel.classList.contains("pipewhat-collapsed");
    const w = collapsed ? COLLAPSED_VISIBLE_PX : Math.round(panel.getBoundingClientRect().width);
    document.body.style.transition = "margin-right 0.22s cubic-bezier(.25,.8,.25,1)";
    document.body.style.marginRight = w + "px";
  }

  // Confirmación in-DOM (no usamos confirm() nativo que bloquea la página).
  // Si danger === true, pinta el botón OK en rojo. Si promptLabel presente,
  // incluye un input opcional y devuelve { ok, value }.
  function openConfirm({ title, message, okText = "Confirmar", danger = false, promptLabel = null, promptPlaceholder = "" }) {
    return new Promise((resolve) => {
      const input = promptLabel ? $("input", { type: "text", class: "pipewhat-dialog-input", placeholder: promptPlaceholder }) : null;

      const close = (result) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(promptLabel ? { ok: false, value: "" } : false); }
        if (e.key === "Enter" && document.activeElement !== input) {
          e.preventDefault();
          close(promptLabel ? { ok: true, value: input ? input.value : "" } : true);
        }
      };

      const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });
      cancelBtn.addEventListener("click", () => close(promptLabel ? { ok: false, value: "" } : false));
      const okClass = danger ? "pipewhat-btn pipewhat-btn-lost" : "pipewhat-btn pipewhat-btn-primary";
      const okBtn = $("button", { class: okClass, text: okText });
      okBtn.addEventListener("click", () => close(promptLabel ? { ok: true, value: input ? input.value : "" } : true));

      const children = [
        $("div", { class: "pipewhat-dialog-title", text: title }),
        message ? $("div", { class: "pipewhat-dialog-msg", text: message }) : null
      ];
      if (promptLabel) {
        children.push($("label", { class: "pipewhat-dialog-label", text: promptLabel }));
        children.push(input);
      }
      children.push($("div", { class: "pipewhat-dialog-actions" }, [cancelBtn, okBtn]));

      const box = $("div", { class: "pipewhat-dialog-content" }, children);
      const overlay = $("div", { class: "pipewhat-dialog-overlay" });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(promptLabel ? { ok: false, value: "" } : false); });
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => (input || okBtn).focus(), 30);
      document.addEventListener("keydown", onKey, true);
    });
  }

  function attachResize(panel, handle) {
    let startX = 0, startW = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const next = Math.max(300, Math.min(900, startW + dx));
      panel.style.width = next + "px";
      syncBodyMargin(panel);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      const w = parseInt(panel.style.width, 10);
      if (w) safeSet({ pipewhatWidth: w });
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function setBody(children) {
    const panel = ensurePanel();
    const body = panel.querySelector(".pipewhat-body");
    body.replaceChildren(...[].concat(children));
  }

  function renderState(msg) {
    setBody($("div", { class: "pipewhat-state", text: msg }));
  }

  function renderMatch(data) {
    const p = data.person || {};
    const deals = data.deals || [];

    const header = $("div", { class: "pipewhat-header" }, [
      $("div", { class: "pipewhat-name", text: p.name || "(sin nombre)" }),
      p.org_id && p.org_id.name ? $("div", { class: "pipewhat-org", text: p.org_id.name }) : null,
      p.owner_id && p.owner_id.name ? $("div", { class: "pipewhat-owner" }, [
        "Dueño: ",
        $("strong", { class: "pipewhat-owner-name", text: p.owner_id.name })
      ]) : null
    ]);

    const contact = $("div", { class: "pipewhat-contact" });
    (p.phone || []).forEach((ph) => {
      if (!ph || !ph.value) return;
      const line = $("div", { class: "pipewhat-line" });
      const val = $("span", {
        class: "pipewhat-copyable",
        title: "Click para copiar",
        onclick: (e) => copyToClipboard(ph.value, e.currentTarget)
      }, "☎ " + ph.value + (ph.label ? ` (${ph.label})` : ""));
      line.appendChild(val);
      contact.appendChild(line);
    });
    const bcc = cachedSettings && cachedSettings.smartBccEmail;
    (p.email || []).forEach((em) => {
      if (!em || !em.value) return;
      const line = $("div", { class: "pipewhat-line" });
      const val = $("span", {
        class: "pipewhat-copyable",
        title: "Click para copiar",
        onclick: (e) => copyToClipboard(em.value, e.currentTarget)
      }, "✉ " + em.value);
      line.appendChild(val);
      const params = new URLSearchParams();
      if (bcc) params.set("bcc", bcc);
      const href = "mailto:" + em.value + (params.toString() ? "?" + params.toString() : "");
      const link = $("a", {
        class: "pipewhat-email-link",
        href,
        title: bcc ? "Se enviará con BCC al Smart Email de Pipedrive (queda loggeado)" : "Enviar email"
      }, bcc ? "Enviar ✉" : "Enviar");
      line.appendChild(link);
      contact.appendChild(line);
    });

    // Agregar teléfono / email a persona existente
    const contactActions = $("div", { class: "pipewhat-contact-actions" });
    const addContactBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });
    contactActions.appendChild($("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        const hidden = addContactBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderAddContactForm(addContactBox, p, "phone", () => refresh(true));
      }
    }, "+ Tel"));
    contactActions.appendChild($("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        const hidden = addContactBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderAddContactForm(addContactBox, p, "email", () => refresh(true));
      }
    }, "+ Email"));
    contact.appendChild(contactActions);
    contact.appendChild(addContactBox);

    const dealsEl = $("div", { class: "pipewhat-deals" });

    const newDealBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });
    const dealsHeader = $("div", { class: "pipewhat-deals-title" }, [
      $("span", { text: "Deals" }),
      $("span", {}, [
        $("span", { class: "pipewhat-deals-count", text: String(deals.length) }),
        " ",
        $("button", {
          class: "pipewhat-deal-toggle",
          style: "margin-left: 6px;",
          onclick: () => {
            const hidden = newDealBox.classList.toggle("pipewhat-hidden");
            if (!hidden) renderNewDealForm(newDealBox, p, () => refresh(true));
          }
        }, "+ Nuevo")
      ])
    ]);
    dealsEl.appendChild(dealsHeader);
    dealsEl.appendChild(newDealBox);

    if (deals.length === 0) {
      dealsEl.appendChild($("div", { class: "pipewhat-state", text: "Sin deals asociados." }));
    } else {
      deals.forEach((d) => dealsEl.appendChild(renderDealCard(d, p)));
    }

    const footer = $("div", { class: "pipewhat-footer" }, [
      $("button", { class: "pipewhat-btn", onclick: () => refresh(true) }, "Refrescar"),
      $("a", { class: "pipewhat-link", target: "_blank", rel: "noopener", href: pipedrivePersonUrl(p.id) }, "Abrir en Pipedrive ↗")
    ]);

    setBody([header, contact, dealsEl, footer]);
  }

  function renderDealCard(d, person) {
    const statusClass = "pipewhat-status-" + (d.status || "open");
    const card = $("div", { class: "pipewhat-deal" });
    const title = $("div", { class: "pipewhat-deal-title", text: d.title || `Deal #${d.id}` });
    const stageLabel = (d.pipeline_name && d.stage_name)
      ? `${d.pipeline_name} · ${d.stage_name}`
      : (d.stage_name || ("Stage " + (d.stage_id || "")));
    const meta = $("div", { class: "pipewhat-deal-meta" }, [
      $("span", { class: "pipewhat-pill " + statusClass, text: d.status || "open" }),
      $("span", { class: "pipewhat-pill", title: d.pipeline_name || "", text: stageLabel }),
      $("span", { class: "pipewhat-money", text: formatMoney(d.value, d.currency) })
    ]);

    const flowBox = $("div", { class: "pipewhat-flow pipewhat-hidden" });
    const noteFormBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });
    const activityFormBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });
    const editFormBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });
    const emailFormBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });

    const allForms = [noteFormBox, activityFormBox, editFormBox, emailFormBox];
    const closeOthers = (keep) => allForms.forEach((f) => { if (f !== keep) f.classList.add("pipewhat-hidden"); });

    const refreshFlowIfOpen = async () => {
      if (flowBox.classList.contains("pipewhat-hidden")) return;
      flowBox.replaceChildren($("div", { class: "pipewhat-state", text: "Cargando…" }));
      try {
        const resp = await safeSendMessage({ action: "getDealFlow", dealId: d.id, limit: 15 });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        renderFlow(flowBox, resp.data || [], d.id);
      } catch (err) {
        flowBox.replaceChildren($("div", { class: "pipewhat-error", text: err.message }));
      }
    };

    const historyBtn = $("button", {
      class: "pipewhat-deal-toggle",
      onclick: async () => {
        const hidden = flowBox.classList.toggle("pipewhat-hidden");
        historyBtn.textContent = hidden ? "Ver historia ▾" : "Ocultar ▴";
        if (!hidden) await refreshFlowIfOpen();
      }
    }, "Ver historia ▾");

    const noteBtn = $("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        closeOthers(noteFormBox);
        const hidden = noteFormBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderNoteForm(noteFormBox, d, person, refreshFlowIfOpen);
      }
    }, "+ Nota");

    const activityBtn = $("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        closeOthers(activityFormBox);
        const hidden = activityFormBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderActivityForm(activityFormBox, d, person, refreshFlowIfOpen);
      }
    }, "+ Actividad");

    const editBtn = $("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        closeOthers(editFormBox);
        const hidden = editFormBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderEditDealForm(editFormBox, d, person, () => refresh(true));
      }
    }, "✎ Editar");

    // Sólo mostrar Email si la persona tiene al menos un email.
    const primaryEmail = (person && (person.email || []).find((e) => e && e.value));
    const emailBtn = primaryEmail ? $("button", {
      class: "pipewhat-deal-toggle",
      onclick: () => {
        closeOthers(emailFormBox);
        const hidden = emailFormBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderEmailComposeForm(emailFormBox, d, person, primaryEmail.value);
      }
    }, "📧 Email") : null;

    const actionButtons = [historyBtn, noteBtn, activityBtn, editBtn];
    if (emailBtn) actionButtons.push(emailBtn);
    const actions = $("div", { class: "pipewhat-deal-actions" }, actionButtons);

    // Banner de próxima actividad pendiente (si existe)
    let nextActivityBanner = null;
    if (d.next_activity_id && d.next_activity_subject) {
      nextActivityBanner = $("div", { class: "pipewhat-next-activity" });
      const label = $("div", { class: "pipewhat-next-label" }, [
        $("span", { class: "pipewhat-next-icon", text: "⏰" }),
        $("div", {}, [
          $("div", { class: "pipewhat-next-subject", text: d.next_activity_subject }),
          $("div", { class: "pipewhat-next-date", text: formatDate(d.next_activity_date) + (d.next_activity_time ? " " + d.next_activity_time : "") })
        ])
      ]);
      const doneBtn = $("button", {
        class: "pipewhat-btn pipewhat-btn-primary pipewhat-btn-sm",
        onclick: async () => {
          const ok = await openConfirm({
            title: "Marcar actividad como hecha",
            message: `"${d.next_activity_subject}" — se cerrará en Pipedrive.`,
            okText: "✓ Marcar hecha"
          });
          if (!ok) return;
          doneBtn.disabled = true;
          doneBtn.textContent = "…";
          try {
            const resp = await safeSendMessage({ action: "completeActivity", activityId: d.next_activity_id });
            if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
            refresh(true);
          } catch (err) {
            doneBtn.textContent = "Error";
            doneBtn.title = err.message;
          }
        }
      }, "✓ Hecha");
      nextActivityBanner.append(label, doneBtn);
    }

    const openLink = $("a", {
      class: "pipewhat-link",
      target: "_blank",
      rel: "noopener",
      href: pipedriveDealUrl(d.id)
    }, "Abrir deal ↗");

    card.append(title, meta);
    if (nextActivityBanner) card.appendChild(nextActivityBanner);
    card.append(actions, noteFormBox, activityFormBox, editFormBox, emailFormBox, flowBox, openLink);
    return card;
  }

  function renderEmailComposeForm(container, deal, person, toEmail) {
    const bcc = cachedSettings && cachedSettings.smartBccEmail;

    const toInput = $("input", { type: "email", class: "pipewhat-input", value: toEmail || "", placeholder: "destinatario@dominio.com" });
    const subjectInput = $("input", {
      type: "text",
      class: "pipewhat-input",
      value: deal && deal.title ? `${deal.title}` : "",
      placeholder: "Asunto"
    });
    const bodyInput = $("textarea", {
      class: "pipewhat-textarea",
      rows: "5",
      placeholder: person && person.name
        ? `Hola ${(person.name || "").split(" ")[0]},\n\n`
        : "Hola,\n\n"
    });
    bodyInput.value = person && person.name
      ? `Hola ${(person.name || "").split(" ")[0]},\n\n`
      : "Hola,\n\n";

    const info = $("div", { class: "pipewhat-form-status" });
    if (bcc) {
      info.textContent = "Se enviará con BCC a " + bcc + " — queda loggeado en Pipedrive ✓";
      info.className = "pipewhat-form-status pipewhat-form-ok";
    } else {
      info.textContent = "Sin Smart BCC configurado — configúralo en Opciones para que quede loggeado en Pipedrive.";
    }

    const openBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Abrir en mi cliente de mail" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    openBtn.addEventListener("click", () => {
      const to = toInput.value.trim();
      if (!to) return;
      const params = new URLSearchParams();
      if (subjectInput.value) params.set("subject", subjectInput.value);
      if (bodyInput.value) params.set("body", bodyInput.value);
      if (bcc) params.set("bcc", bcc);
      const href = "mailto:" + encodeURIComponent(to).replace(/%40/g, "@") + (params.toString() ? "?" + params.toString() : "");
      // Abrimos en la misma pestaña para que el handler del mail del SO tome el protocolo.
      window.location.href = href;
      setTimeout(() => container.classList.add("pipewhat-hidden"), 400);
    });
    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      $("label", { class: "pipewhat-form-label", text: "Para" }),
      toInput,
      $("label", { class: "pipewhat-form-label", text: "Asunto" }),
      subjectInput,
      $("label", { class: "pipewhat-form-label", text: "Mensaje" }),
      bodyInput,
      $("div", { class: "pipewhat-form-actions" }, [openBtn, cancelBtn]),
      info
    );
    setTimeout(() => subjectInput.focus(), 50);
  }

  // ---------- action forms ----------

  function renderNoteForm(container, deal, person, onDone) {
    const textarea = $("textarea", {
      class: "pipewhat-textarea",
      rows: "3",
      placeholder: "Escribí la nota…"
    });
    const status = $("div", { class: "pipewhat-form-status" });
    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Guardar nota" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    saveBtn.addEventListener("click", async () => {
      const content = textarea.value.trim();
      if (!content) {
        status.textContent = "La nota está vacía";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      saveBtn.disabled = true;
      status.textContent = "Guardando…";
      status.className = "pipewhat-form-status";
      try {
        const resp = await safeSendMessage({
          action: "createNote",
          payload: { dealId: deal.id, personId: person && person.id, content }
        });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = "Nota guardada ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        textarea.value = "";
        setTimeout(() => {
          container.classList.add("pipewhat-hidden");
          onDone && onDone();
        }, 700);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      } finally {
        saveBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      textarea,
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, cancelBtn]),
      status
    );
    setTimeout(() => textarea.focus(), 50);
  }

  function todayISO(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function renderActivityForm(container, deal, person, onDone) {
    const subjectInput = $("input", { type: "text", class: "pipewhat-input", placeholder: "Asunto (ej. Llamar a Juan)" });
    const typeSelect = $("select", { class: "pipewhat-input" }, [
      $("option", { value: "task" }, "Tarea"),
      $("option", { value: "call" }, "Llamada"),
      $("option", { value: "meeting" }, "Reunión"),
      $("option", { value: "email" }, "Email"),
      $("option", { value: "deadline" }, "Deadline")
    ]);
    const dateInput = $("input", { type: "date", class: "pipewhat-input", value: todayISO(1) });
    const timeInput = $("input", { type: "time", class: "pipewhat-input" });
    const noteInput = $("textarea", { class: "pipewhat-textarea", rows: "2", placeholder: "Nota (opcional)" });

    const status = $("div", { class: "pipewhat-form-status" });
    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Crear actividad" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    // Presets rápidos
    const applyPreset = (subject, type, offsetDays, time) => {
      subjectInput.value = subject;
      typeSelect.value = type;
      dateInput.value = todayISO(offsetDays);
      timeInput.value = time || "";
    };
    const presets = $("div", { class: "pipewhat-presets" }, [
      $("button", { class: "pipewhat-chip", onclick: () => applyPreset("Llamar", "call", 1, "10:00") }, "📞 Llamar mañana"),
      $("button", { class: "pipewhat-chip", onclick: () => applyPreset("Recontactar", "task", 3) }, "⏰ Recontactar en 3 días"),
      $("button", { class: "pipewhat-chip", onclick: () => applyPreset("Recontactar", "task", 7) }, "📅 En 1 semana"),
      $("button", { class: "pipewhat-chip", onclick: () => applyPreset("Reunión", "meeting", 2, "11:00") }, "🤝 Reunión +2d")
    ]);

    saveBtn.addEventListener("click", async () => {
      const subject = subjectInput.value.trim();
      if (!subject) {
        status.textContent = "Falta el asunto";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      saveBtn.disabled = true;
      status.textContent = "Creando…";
      status.className = "pipewhat-form-status";
      try {
        const resp = await safeSendMessage({
          action: "createActivity",
          payload: {
            dealId: deal.id,
            personId: person && person.id,
            subject,
            type: typeSelect.value,
            dueDate: dateInput.value || null,
            dueTime: timeInput.value || null,
            note: noteInput.value || null
          }
        });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = "Actividad creada ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        setTimeout(() => {
          container.classList.add("pipewhat-hidden");
          onDone && onDone();
        }, 700);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      } finally {
        saveBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      presets,
      subjectInput,
      $("div", { class: "pipewhat-form-row" }, [typeSelect, dateInput, timeInput]),
      noteInput,
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, cancelBtn]),
      status
    );
    setTimeout(() => subjectInput.focus(), 50);
  }

  async function renderEditDealForm(container, deal, person, onDone) {
    container.replaceChildren($("div", { class: "pipewhat-form-status", text: "Cargando etapas y usuarios…" }));

    let stages = [];
    let users = [];
    try {
      const [stagesResp, usersResp] = await Promise.all([
        safeSendMessage({ action: "getStages" }),
        safeSendMessage({ action: "getUsers" })
      ]);
      if (!stagesResp || !stagesResp.success) throw new Error(stagesResp && stagesResp.error || "Error al cargar etapas");
      stages = stagesResp.data || [];
      users = (usersResp && usersResp.success) ? (usersResp.data || []) : [];
    } catch (err) {
      container.replaceChildren($("div", { class: "pipewhat-form-status pipewhat-form-error", text: err.message }));
      return;
    }

    const pipelineStages = stages.filter((s) => s.pipeline_id === deal.pipeline_id);

    const stageSelect = $("select", { class: "pipewhat-input" });
    pipelineStages.forEach((s) => {
      const opt = $("option", { value: String(s.id), text: s.name });
      if (s.id === deal.stage_id) opt.selected = true;
      stageSelect.appendChild(opt);
    });

    // Dueño: el deal tiene owner_id / user_id (son equivalentes en la API)
    const currentOwnerId = (deal.owner_id && (deal.owner_id.id || deal.owner_id.value)) || deal.user_id || null;
    const ownerSelect = $("select", { class: "pipewhat-input" });
    if (users.length === 0) {
      ownerSelect.appendChild($("option", { value: "", text: "— sin cambio —" }));
    } else {
      users.forEach((u) => {
        const opt = $("option", { value: String(u.id), text: u.name + (u.email ? ` (${u.email})` : "") });
        if (u.id === currentOwnerId) opt.selected = true;
        ownerSelect.appendChild(opt);
      });
    }

    const valueInput = $("input", {
      type: "number",
      class: "pipewhat-input",
      placeholder: "Valor",
      step: "0.01",
      value: deal.value != null ? String(deal.value) : ""
    });
    const currencyInput = $("input", {
      type: "text",
      class: "pipewhat-input",
      placeholder: "ARS",
      maxlength: "3",
      value: deal.currency || ""
    });

    const status = $("div", { class: "pipewhat-form-status" });

    const runUpdate = async (updates, successMsg) => {
      status.textContent = "Guardando…";
      status.className = "pipewhat-form-status";
      try {
        const resp = await safeSendMessage({
          action: "updateDeal",
          dealId: deal.id,
          updates
        });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = successMsg || "Guardado ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        setTimeout(() => {
          container.classList.add("pipewhat-hidden");
          onDone && onDone();
        }, 700);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      }
    };

    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Guardar cambios" });
    const wonBtn = $("button", { class: "pipewhat-btn pipewhat-btn-won", text: "🏆 Won" });
    const lostBtn = $("button", { class: "pipewhat-btn pipewhat-btn-lost", text: "❌ Lost" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    saveBtn.addEventListener("click", () => {
      const updates = {};
      const newStage = Number(stageSelect.value);
      if (newStage && newStage !== deal.stage_id) updates.stage_id = newStage;
      const newVal = valueInput.value.trim() === "" ? null : Number(valueInput.value);
      if (newVal != null && newVal !== deal.value) updates.value = newVal;
      const newCur = currencyInput.value.trim().toUpperCase();
      if (newCur && newCur !== (deal.currency || "").toUpperCase()) updates.currency = newCur;
      const newOwner = ownerSelect.value ? Number(ownerSelect.value) : null;
      if (newOwner && newOwner !== currentOwnerId) updates.user_id = newOwner;
      if (!Object.keys(updates).length) {
        status.textContent = "Sin cambios";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      runUpdate(updates, "Deal actualizado ✓");
    });

    wonBtn.addEventListener("click", async () => {
      const ok = await openConfirm({
        title: "Marcar deal como ganado",
        message: `"${deal.title}" se va a marcar como Won en Pipedrive.`,
        okText: "🏆 Marcar Won"
      });
      if (ok) runUpdate({ status: "won" }, "Deal marcado como Won 🏆");
    });

    lostBtn.addEventListener("click", async () => {
      const res = await openConfirm({
        title: "Marcar deal como perdido",
        message: `"${deal.title}" se va a marcar como Lost en Pipedrive.`,
        okText: "❌ Marcar Lost",
        danger: true,
        promptLabel: "Razón de pérdida (opcional)",
        promptPlaceholder: "Ej. precio, competencia, no respondió…"
      });
      if (res && res.ok) {
        const updates = { status: "lost" };
        if (res.value && res.value.trim()) updates.lost_reason = res.value.trim();
        runUpdate(updates, "Deal marcado como Lost");
      }
    });

    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      $("label", { class: "pipewhat-form-label", text: "Etapa" }),
      stageSelect,
      $("label", { class: "pipewhat-form-label", text: "Valor" }),
      $("div", { class: "pipewhat-form-row-2" }, [valueInput, currencyInput]),
      $("label", { class: "pipewhat-form-label", text: "Dueño" }),
      ownerSelect,
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, wonBtn, lostBtn, cancelBtn]),
      status
    );
  }

  function renderAddContactForm(container, person, kind, onDone) {
    const isPhone = kind === "phone";
    const input = $("input", {
      type: isPhone ? "tel" : "email",
      class: "pipewhat-input",
      placeholder: isPhone ? "+54 11 5555-5555" : "correo@dominio.com"
    });
    const status = $("div", { class: "pipewhat-form-status" });
    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Agregar" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    saveBtn.addEventListener("click", async () => {
      const v = input.value.trim();
      if (!v) {
        status.textContent = "Vacío";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      saveBtn.disabled = true;
      status.textContent = "Guardando…";
      status.className = "pipewhat-form-status";
      const payload = { personId: person.id };
      payload[kind] = v;
      try {
        const resp = await safeSendMessage({ action: "addPersonContact", payload });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = "Agregado ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        setTimeout(() => { onDone && onDone(); }, 600);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      } finally {
        saveBtn.disabled = false;
      }
    });
    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      $("label", { class: "pipewhat-form-label", text: isPhone ? "Nuevo teléfono" : "Nuevo email" }),
      input,
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, cancelBtn]),
      status
    );
    setTimeout(() => input.focus(), 50);
  }

  async function renderNewDealForm(container, person, onDone) {
    container.replaceChildren($("div", { class: "pipewhat-form-status", text: "Cargando pipelines…" }));

    let pipelines = [];
    let stages = [];
    try {
      const [pipResp, stgResp] = await Promise.all([
        safeSendMessage({ action: "getPipelines" }),
        safeSendMessage({ action: "getStages" })
      ]);
      if (!pipResp || !pipResp.success) throw new Error(pipResp && pipResp.error || "Error");
      if (!stgResp || !stgResp.success) throw new Error(stgResp && stgResp.error || "Error");
      pipelines = pipResp.data || [];
      stages = stgResp.data || [];
    } catch (err) {
      container.replaceChildren($("div", { class: "pipewhat-form-status pipewhat-form-error", text: err.message }));
      return;
    }

    const titleInput = $("input", {
      type: "text",
      class: "pipewhat-input",
      placeholder: "Título del deal",
      value: person.name ? `Oportunidad — ${person.name}` : ""
    });
    const valueInput = $("input", { type: "number", class: "pipewhat-input", placeholder: "Valor", step: "0.01" });
    const currencyInput = $("input", { type: "text", class: "pipewhat-input", placeholder: "ARS", maxlength: "3" });

    const pipelineSelect = $("select", { class: "pipewhat-input" });
    pipelines.forEach((pl) => {
      pipelineSelect.appendChild($("option", { value: String(pl.id), text: pl.name }));
    });

    const stageSelect = $("select", { class: "pipewhat-input" });
    const refillStages = () => {
      const pid = Number(pipelineSelect.value);
      const filtered = stages.filter((s) => s.pipeline_id === pid);
      stageSelect.replaceChildren();
      filtered.forEach((s) => stageSelect.appendChild($("option", { value: String(s.id), text: s.name })));
    };
    pipelineSelect.addEventListener("change", refillStages);
    refillStages();

    const status = $("div", { class: "pipewhat-form-status" });
    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Crear deal" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    saveBtn.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      if (!title) {
        status.textContent = "Falta el título";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      saveBtn.disabled = true;
      status.textContent = "Creando…";
      status.className = "pipewhat-form-status";
      try {
        const resp = await safeSendMessage({
          action: "createDeal",
          payload: {
            title,
            value: valueInput.value.trim() === "" ? null : valueInput.value.trim(),
            currency: currencyInput.value.trim().toUpperCase() || null,
            personId: person.id,
            stageId: stageSelect.value ? Number(stageSelect.value) : null
          }
        });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = "Deal creado ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        setTimeout(() => { onDone && onDone(); }, 700);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      } finally {
        saveBtn.disabled = false;
      }
    });
    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      $("label", { class: "pipewhat-form-label", text: "Título" }),
      titleInput,
      $("label", { class: "pipewhat-form-label", text: "Pipeline / etapa" }),
      $("div", { class: "pipewhat-form-row-2" }, [pipelineSelect, stageSelect]),
      $("label", { class: "pipewhat-form-label", text: "Valor" }),
      $("div", { class: "pipewhat-form-row-2" }, [valueInput, currencyInput]),
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, cancelBtn]),
      status
    );
    setTimeout(() => titleInput.focus(), 50);
  }

  function renderNoMatch(container, phone) {
    const formBox = $("div", { class: "pipewhat-action-form pipewhat-hidden" });

    const createBtn = $("button", {
      class: "pipewhat-btn pipewhat-btn-primary",
      onclick: () => {
        const hidden = formBox.classList.toggle("pipewhat-hidden");
        if (!hidden) renderCreatePersonForm(formBox, phone, () => refresh(true));
      }
    }, "+ Crear persona en Pipedrive");

    const retryBtn = $("button", { class: "pipewhat-btn", onclick: () => refresh(true) }, "Reintentar");

    container.replaceChildren(
      $("div", { class: "pipewhat-state", text: `Sin match en Pipedrive para ${phone}` }),
      $("div", { class: "pipewhat-form-actions", style: "justify-content: center; margin-top: 8px;" }, [createBtn, retryBtn]),
      formBox
    );
  }

  function renderCreatePersonForm(container, phone, onDone) {
    const nameInput = $("input", { type: "text", class: "pipewhat-input", placeholder: "Nombre completo" });
    const phoneInput = $("input", { type: "text", class: "pipewhat-input", value: phone || "" });
    const emailInput = $("input", { type: "email", class: "pipewhat-input", placeholder: "Email (opcional)" });
    const status = $("div", { class: "pipewhat-form-status" });
    const saveBtn = $("button", { class: "pipewhat-btn pipewhat-btn-primary", text: "Crear persona" });
    const cancelBtn = $("button", { class: "pipewhat-btn", text: "Cancelar" });

    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        status.textContent = "Falta el nombre";
        status.className = "pipewhat-form-status pipewhat-form-error";
        return;
      }
      saveBtn.disabled = true;
      status.textContent = "Creando…";
      status.className = "pipewhat-form-status";
      try {
        const resp = await safeSendMessage({
          action: "createPerson",
          payload: { name, phone: phoneInput.value.trim(), email: emailInput.value.trim() }
        });
        if (!resp || !resp.success) throw new Error(resp && resp.error || "Error");
        status.textContent = "Persona creada ✓";
        status.className = "pipewhat-form-status pipewhat-form-ok";
        setTimeout(() => { onDone && onDone(); }, 700);
      } catch (err) {
        status.textContent = err.message;
        status.className = "pipewhat-form-status pipewhat-form-error";
      } finally {
        saveBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener("click", () => container.classList.add("pipewhat-hidden"));

    container.replaceChildren(
      $("label", { class: "pipewhat-form-label", text: "Nombre" }),
      nameInput,
      $("label", { class: "pipewhat-form-label", text: "Teléfono" }),
      phoneInput,
      $("label", { class: "pipewhat-form-label", text: "Email" }),
      emailInput,
      $("div", { class: "pipewhat-form-actions" }, [saveBtn, cancelBtn]),
      status
    );
    setTimeout(() => nameInput.focus(), 50);
  }

  // Íconos por tipo de evento + subtipo de actividad
  const ACTIVITY_TYPE_ICONS = {
    call: "📞",
    meeting: "🤝",
    task: "✅",
    email: "✉️",
    deadline: "⏰",
    lunch: "🍽️"
  };
  const FLOW_TYPE_LABELS = {
    activity: "Actividad",
    note: "Nota",
    file: "Archivo",
    mailMessage: "Email",
    dealChange: "Cambio",
    person: "Persona"
  };

  function iconForFlowItem(type, obj) {
    if (type === "activity") return ACTIVITY_TYPE_ICONS[obj && obj.type] || "📌";
    if (type === "note") return "📝";
    if (type === "file") return "📎";
    if (type === "mailMessage") return "✉️";
    if (type === "dealChange") return "🔄";
    if (type === "person") return "👤";
    return "•";
  }

  // Strip HTML + decode entities de forma segura (textarea no ejecuta scripts).
  function stripHtml(html) {
    if (!html) return "";
    const noTags = String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "");
    const ta = document.createElement("textarea");
    ta.innerHTML = noTags;
    return ta.value.replace(/\n{3,}/g, "\n\n").trim();
  }

  function renderFlow(container, items, dealId) {
    if (!Array.isArray(items) || items.length === 0) {
      container.replaceChildren($("div", { class: "pipewhat-state", text: "Sin eventos." }));
      return;
    }
    const list = $("ul", { class: "pipewhat-timeline" });
    items.forEach((entry) => {
      const obj = entry.data || entry.object || {};
      const type = entry.object || entry.type || "evento";
      const ts = entry.timestamp || obj.add_time || obj.update_time || "";
      const li = $("li", { class: "pipewhat-flow-item" }, [
        $("div", { class: "pipewhat-flow-head" }, [
          $("span", { class: "pipewhat-flow-icon", text: iconForFlowItem(type, obj) }),
          $("span", { class: "pipewhat-flow-type", text: FLOW_TYPE_LABELS[type] || type }),
          $("span", { class: "pipewhat-flow-date", text: formatDate(ts) })
        ]),
        renderFlowBody(type, obj, dealId)
      ]);
      list.appendChild(li);
    });
    container.replaceChildren(list);
  }

  function isImageAttachment(obj) {
    const mime = String(obj.file_type || obj.mime_type || "").toLowerCase();
    if (mime.startsWith("image/")) return true;
    const name = String(obj.name || obj.file_name || "").toLowerCase();
    return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
  }

  function renderFlowBody(type, obj, dealId) {
    const body = $("div", { class: "pipewhat-flow-summary" });
    if (!obj) return body;

    if (type === "activity") {
      const text = obj.subject || FLOW_TYPE_LABELS.activity;
      body.appendChild(document.createTextNode(text));
      if (obj.done) {
        const chip = $("span", { class: "pipewhat-mini-chip pipewhat-chip-done", text: "✓ hecha" });
        body.appendChild(chip);
      }
      if (obj.note) {
        const clean = stripHtml(obj.note);
        if (clean) {
          body.appendChild($("div", { class: "pipewhat-flow-note", text: clean }));
        }
      }
      return body;
    }

    if (type === "note") {
      const full = stripHtml(obj.content || "");
      if (!full) return body;
      const SHORT = 180;
      if (full.length <= SHORT) {
        body.appendChild($("div", { class: "pipewhat-flow-note", text: full }));
      } else {
        const preview = $("div", { class: "pipewhat-flow-note", text: full.slice(0, SHORT) + "…" });
        const full_el = $("div", { class: "pipewhat-flow-note pipewhat-hidden", text: full });
        const btn = $("button", { class: "pipewhat-flow-more", text: "Ver más" });
        btn.addEventListener("click", () => {
          const isHidden = full_el.classList.contains("pipewhat-hidden");
          if (isHidden) {
            preview.classList.add("pipewhat-hidden");
            full_el.classList.remove("pipewhat-hidden");
            btn.textContent = "Ver menos";
          } else {
            preview.classList.remove("pipewhat-hidden");
            full_el.classList.add("pipewhat-hidden");
            btn.textContent = "Ver más";
          }
        });
        body.append(preview, full_el, btn);
      }
      return body;
    }

    if (type === "file") {
      const name = obj.name || obj.file_name || "archivo";
      const fileId = obj.id || obj.file_id || null;
      const dealIdFromFile = obj.deal_id || dealId;

      if (isImageAttachment(obj) && fileId) {
        // Imagen: cargar inline con URL firmada del service worker.
        const wrap = $("div", { class: "pipewhat-flow-imgwrap" });
        const caption = $("div", { class: "pipewhat-flow-filename", text: name });
        const img = $("img", {
          class: "pipewhat-flow-image",
          alt: name,
          loading: "lazy"
        });
        img.style.cssText = "max-width:100%; max-height:220px; border-radius:6px; display:block; margin-top:4px; cursor:pointer; background:#f1f5f9;";
        wrap.append(caption, img);

        (async () => {
          try {
            const resp = await chrome.runtime.sendMessage({ action: "getFileDownloadUrl", fileId });
            if (resp && resp.success && resp.data) {
              img.src = resp.data;
              img.addEventListener("click", () => window.open(resp.data, "_blank", "noopener"));
            } else {
              img.replaceWith($("div", { class: "pipewhat-flow-filesize", text: "(no se pudo cargar la imagen)" }));
            }
          } catch {
            img.replaceWith($("div", { class: "pipewhat-flow-filesize", text: "(no se pudo cargar la imagen)" }));
          }
        })();

        body.appendChild(wrap);
      } else {
        // No-imagen: al click, abrir el deal en Pipedrive (evita todo lío de
        // auth / descargas y le da al usuario el contexto completo del archivo).
        const href = dealIdFromFile ? pipedriveDealUrl(dealIdFromFile) : null;
        if (href) {
          body.appendChild($("a", {
            class: "pipewhat-flow-file",
            href,
            target: "_blank",
            rel: "noopener",
            title: "Abrir el deal en Pipedrive para descargar",
            text: name + " ↗"
          }));
        } else {
          body.appendChild(document.createTextNode(name));
        }
      }

      if (obj.file_size) {
        const kb = Math.round(Number(obj.file_size) / 1024);
        body.appendChild($("span", { class: "pipewhat-flow-filesize", text: " " + (kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB") }));
      }
      return body;
    }

    if (type === "dealChange") {
      const field = obj.friendly_field || obj.field_key || "campo";
      const oldV = obj.old_value_label != null ? obj.old_value_label : (obj.old_value != null ? String(obj.old_value) : "—");
      const newV = obj.new_value_label != null ? obj.new_value_label : (obj.new_value != null ? String(obj.new_value) : "—");

      // Status: pills coloreadas
      if (obj.field_key === "status") {
        const wrap = $("span");
        wrap.append(
          field + ": ",
          $("span", { class: "pipewhat-mini-chip pipewhat-status-" + (oldV || "open"), text: oldV }),
          " → ",
          $("span", { class: "pipewhat-mini-chip pipewhat-status-" + (newV || "open"), text: newV })
        );
        body.appendChild(wrap);
        return body;
      }

      body.appendChild($("strong", { text: field + ": " }));
      body.appendChild(document.createTextNode(oldV + " → " + newV));
      return body;
    }

    if (type === "mailMessage") {
      body.appendChild($("strong", { text: obj.subject || "(sin asunto)" }));
      if (obj.snippet || obj.body_excerpt) {
        const snippet = stripHtml(obj.snippet || obj.body_excerpt);
        if (snippet) body.appendChild($("div", { class: "pipewhat-flow-note", text: snippet.slice(0, 180) }));
      }
      return body;
    }

    body.textContent = obj.title || obj.subject || obj.name || "";
    return body;
  }

  async function pipedriveBaseUrl() {
    const { pipedriveCompany } = await safeGet("pipedriveCompany");
    return pipedriveCompany ? `https://${pipedriveCompany}.pipedrive.com` : "https://app.pipedrive.com";
  }

  let _baseUrlCache = null;
  function pipedriveDealUrl(id) {
    return (_baseUrlCache || "https://app.pipedrive.com") + "/deal/" + id;
  }
  function pipedrivePersonUrl(id) {
    return (_baseUrlCache || "https://app.pipedrive.com") + "/person/" + id;
  }

  // ---------- main flow ----------

  async function refresh(force = false) {
    ensurePanel();
    await loadSettings();
    _baseUrlCache = await pipedriveBaseUrl();

    const phone = detectActivePhone();
    if (!phone) {
      currentPhone = null;
      renderState("No detecté un teléfono en la pantalla actual.");
      return;
    }

    if (!force && phone === currentPhone && Date.now() - lastLookupAt < 30000) return;

    currentPhone = phone;
    lastLookupAt = Date.now();
    renderState("Buscando en Pipedrive…");

    try {
      const resp = await safeSendMessage({ action: "lookupByPhone", phone });
      if (!resp || !resp.success) {
        setBody($("div", { class: "pipewhat-error", text: (resp && resp.error) || "Error desconocido" }));
        return;
      }
      if (!resp.data || !resp.data.matched) {
        const wrap = $("div");
        renderNoMatch(wrap, phone);
        setBody(wrap);
        return;
      }
      renderMatch(resp.data);
    } catch (err) {
      setBody($("div", { class: "pipewhat-error", text: err.message || String(err) }));
    }
  }

  // ---------- observers ----------

  let urlPollId = null;
  let domObs = null;
  let lastUrl = location.href;

  function startWatching() {
    ensurePanel();

    urlPollId = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        refresh();
      }
    }, 800);

    domObs = new MutationObserver(() => {
      // Debounce mínimo: sólo refrescamos cuando cambia el teléfono detectado
      const p = detectActivePhone();
      if (p && p !== currentPhone) refresh();
    });
    domObs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // primer lookup
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWatching, { once: true });
  } else {
    startWatching();
  }
})();
