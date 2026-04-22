# Changelog

## 1.0.0 — 2026-04-22

Primera release unificada.

- Fusión de [PipeWhat](https://github.com/pedroknigge/pipewhat) (Pipedrive dentro de Whaticket) y [WhatPipe](https://github.com/pedroknigge/whatpipe) (Whaticket dentro de Pipedrive) en una sola extensión.
- Una instalación atiende ambos dominios: `*.whaticket.com` carga el panel de Pipedrive, `*.pipedrive.com` carga el botón de envío Whaticket.
- Service worker único con ruteo por `action`; cache en memoria de 5 min para Pipedrive.
- Options page con 4 pestañas: **Pipedrive**, **Whaticket**, **Plantillas**, **Ayuda**.
- Popup con estado en vivo de las dos integraciones y banner contextual según la tab activa.
- Atajos `Alt+Shift+P` (panel en Whaticket) y `Alt+Shift+W` (modal en Pipedrive) coexisten.
- Migración automática de claves legacy (`whaticketToken` → `whatpipeToken`, `whaticketTemplates` → `whatpipeTemplates`) para usuarios que vengan de versiones anteriores de WhatPipe.
