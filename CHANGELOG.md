# Changelog

## 1.1.0 — 2026-04-22

- **Nota automática en Pipedrive al enviar WhatsApp** desde el botón/atajo de la extensión. Crea una nota en el deal, persona, lead u organización con fecha, número destino, conexión y contenido del mensaje. Funciona también cuando el deal está abierto en la vista previa (details drawer), no sólo en la página completa. Toggle en Opciones → Whaticket → *Registro en Pipedrive* (default on). También cubre envío masivo: cada destinatario recibe su propia nota.
- **Fix 401 al abrir adjuntos del timeline** desde el panel en Whaticket. El click ahora va al service worker, que resuelve la URL S3 firmada de Pipedrive (`GET /files/:id`) y la abre en una tab nueva. El token nunca se expone al content script.
- Cache de 5 min para `GET /whatsapps` al resolver nombre de la conexión al loggear nota, así no se pega a la API en cada envío.

## 1.0.0 — 2026-04-22

Primera release unificada.

- Fusión de [PipeWhat](https://github.com/pedroknigge/pipewhat) (Pipedrive dentro de Whaticket) y [WhatPipe](https://github.com/pedroknigge/whatpipe) (Whaticket dentro de Pipedrive) en una sola extensión.
- Una instalación atiende ambos dominios: `*.whaticket.com` carga el panel de Pipedrive, `*.pipedrive.com` carga el botón de envío Whaticket.
- Service worker único con ruteo por `action`; cache en memoria de 5 min para Pipedrive.
- Options page con 4 pestañas: **Pipedrive**, **Whaticket**, **Plantillas**, **Ayuda**.
- Popup con estado en vivo de las dos integraciones y banner contextual según la tab activa.
- Atajos `Alt+Shift+P` (panel en Whaticket) y `Alt+Shift+W` (modal en Pipedrive) coexisten.
- Migración automática de claves legacy (`whaticketToken` → `whatpipeToken`, `whaticketTemplates` → `whatpipeTemplates`) para usuarios que vengan de versiones anteriores de WhatPipe.
