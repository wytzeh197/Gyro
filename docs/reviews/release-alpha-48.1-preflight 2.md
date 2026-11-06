# Alpha 48.1 preflight — 14 September 2026

Automated local preflight passed for the Alpha 48.1 candidate. The local
Apple-Silicon DMG passed the macOS release verifier. Signed updater artifacts,
Intel artifacts, clean-user installation, updater acceptance, and publication
remain gated on the tagged GitHub workflow and manual acceptance.

## Candidate scope

- Review scopes now distinguish proposed edits, uncommitted changes, branch
  changes, and files changed by a chat turn.
- Branch review lists files relative to fetched `origin/main`, falling back to
  local `main` when no remote ref exists. Large or unsupported files use a
  bounded text-diff view.
- Workspace search shows matching lines with file and line context. Chat
  companion sizing, browser controls, and session menu layouts were refined.
- ACP screenshot sending, plan rendering, and macOS window-control alignment
  receive fixes.

## Verified

- `CI=1 pnpm install --frozen-lockfile`, `pnpm doctor`, `pnpm release:check`,
  `pnpm check`, `pnpm test`, `pnpm smoke:workbench`, and `pnpm site:check` passed.
- Reliability checks include startup scheduling limits, stale-workspace
  suppression, source-control review, review scope, and large-diff fallback.
- `cargo fmt --all -- --check` passed. `cargo test --workspace --quiet` passed
  with 624 tests passed, 4 ignored, and 0 failed.
- `cargo build -p gyro-cli`, the CLI version check, `pnpm release:cli:check`,
  and `cargo run -p gyro-cli -- doctor --json` passed on Apple Silicon.
- The local production app and Apple-Silicon DMG were built. The DMG passed
  `hdiutil verify`, mounted-content, architecture, bundle-version, and ad-hoc
  signature checks using `scripts/verify-macos-release.mjs`.
- Workbench smoke checks passed at 860x620, 1280x720, 1440x900, and 1728x1117.
- The frontend build reports the existing large-chunk advisory: Monaco's main
  editor chunk is about 3.33 MB minified and the surfaces chunk about 661 KB.

## Remaining release acceptance

- Local updater signing requires `TAURI_SIGNING_PRIVATE_KEY`; the tagged GitHub
  workflow must produce and verify signed updater archives for both
  architectures.
- The local DMG verifier had no `SHA256SUMS` file to compare; verify the
  downloaded draft assets against the workflow-generated checksums.
- Verify Intel app and CLI artifacts on the Intel runner, then complete the
  clean-user Gatekeeper, updater signature, and session-preservation checks
  described in `docs/release.md` before publishing the draft.
- No end-to-end provider benchmark was run because it makes real model calls.
  Automated startup scheduling checks passed; clean-account launch latency and
  provider activity latency remain unmeasured.
