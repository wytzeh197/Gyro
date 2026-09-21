# Project memory

Durable notes this project carries between chats. One entry per line.

- 2026-09-20 — scripts/architecture-size-baseline.json is a hard line ceiling (App.tsx 20451, src-tauri/src/lib.rs 31266); new code there must be extracted into a focused module, never the baseline raised.
- 2026-09-20 — Gyro's own UI cannot be previewed in Gyro's browser rail: apps/desktop/src/surface-boundary.ts forces the "embedded" placeholder when a page is framed. Use scripts/capture-*.mjs headless Chrome captures instead.
- 2026-09-21 — cargo fmt --all -- --check fails on this machine even at an untouched checkout: local rustfmt 1.9.0-stable reformats files the repo committed (e.g. src-tauri/src/provider_reliability.rs is flagged at HEAD). Treat it as toolchain drift, not a branch defect, and do not reformat the Rust workspace during release prep.
