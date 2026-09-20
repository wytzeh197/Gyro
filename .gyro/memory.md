# Project memory

Durable notes this project carries between chats. One entry per line.

- 2026-09-20 — scripts/architecture-size-baseline.json is a hard line ceiling (App.tsx 20451, src-tauri/src/lib.rs 31266); new code there must be extracted into a focused module, never the baseline raised.
- 2026-09-20 — Gyro's own UI cannot be previewed in Gyro's browser rail: apps/desktop/src/surface-boundary.ts forces the "embedded" placeholder when a page is framed. Use scripts/capture-*.mjs headless Chrome captures instead.
