# Project memory

Durable notes this project carries between chats. One entry per line.

- 2026-09-20 — scripts/architecture-size-baseline.json is a hard line ceiling (App.tsx 20451, src-tauri/src/lib.rs 31266); new code there must be extracted into a focused module, never the baseline raised.
- 2026-09-20 — Gyro's own UI cannot be previewed in Gyro's browser rail: apps/desktop/src/surface-boundary.ts forces the "embedded" placeholder when a page is framed. Use scripts/capture-*.mjs headless Chrome captures instead.
- 2026-09-21 — cargo fmt --all -- --check fails on this machine even at an untouched checkout: local rustfmt 1.9.0-stable reformats files the repo committed (e.g. src-tauri/src/provider_reliability.rs is flagged at HEAD). Treat it as toolchain drift, not a branch defect, and do not reformat the Rust workspace during release prep.
- 2026-09-21 — Gyro release completions: a tag push creates a draft; flipping it public (gh release edit --draft=false) is gated on the owner's manual acceptance per docs/release.md (clean-machine Gatekeeper install, updater acceptance, Intel app run) — validate assets/checksums freely, but never publish the draft unprompted.
- 2026-09-22 — When code moves out of apps/desktop/src/App.tsx into a new module, the checks that assert on App.tsx source must follow it: check-workbench-ui.mjs (add a readRepoFile for the module, like liveTerminalPaneSource) and check-chat-side-panel.mjs both read App.tsx by text, and check-startup-performance/check-workspace-capability-sync slice App.tsx between `const X = useCallback` markers.
- 2026-09-22 — Settings surfaces must not reuse --gyro-update-blue or .gyro-update-primary: those belong to the sidebar update button and the workspace-preparation popover. The Updates card uses accent/status tokens (gyro-update-card-primary, SettingsStatus is-info).
