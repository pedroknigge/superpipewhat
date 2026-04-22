# Changelog

## 1.1.2 — 2026-04-22

- **Fix preview de leads en el kanban**: la detección de entidad ahora soporta IDs UUID (leads), lee también query string (`?selectedLead=...`), hash y múltiples tipos de drawer/dialog/modal. Además, un MutationObserver global recuerda el último entity visto en una preview durante 60 s, como red de seguridad cuando el drawer cambia de DOM entre la apertura y el envío.

## 1.1.1 — 2026-04-22

- **Adjuntos del timeline**: imágenes (`jpg/png/gif/webp/bmp/heic`) se muestran ahora **inline** en el panel, cargadas con URL S3 firmada. Click en la imagen la abre a tamaño completo. Para cualquier otro tipo de archivo (PDF, docs, audio, etc.), el click ahora **abre el deal directamente en Pipedrive** en una tab nueva — más simple y evita cualquier problema de permisos/descarga.

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
