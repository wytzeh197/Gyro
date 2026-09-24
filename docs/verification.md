# Verification

How Gyro proves behavior, what each guard is allowed to prove, and which runner
executes it. `scripts/verification-map.json` is the machine-readable copy of
that classification; `scripts/check-guard-registry.mjs` enforces it.

## Every guard has a runner

`scripts/check-guard-registry.mjs` (part of `pnpm test:reliability`) fails when
any `scripts/check-*.mjs` is unreachable from `package.json`, a
`.github/workflows` file, or another guard that itself runs. Seven guards — all
covering then-new chat and workspace behavior — shipped in the 49.x line with
no runner wired to them; the registry exists so that state cannot be committed
again. Adding a guard means wiring it and adding it to
`scripts/verification-map.json` in the same change.

## Behavioral vs source-text

- **Behavioral** guards execute the shipped implementation: importing the
  module, transpiling a function and running it, driving a protocol harness, or
  driving a real browser. They fail on behavior, not wording.
- **Source-text** guards pin repository text or configuration (line ceilings,
  Rust tables a Node process cannot execute, CSS cascade rules). A source-text
  guard is allowed only as a recorded decision: the map requires a reason.

When a source-text guard's subject can execute in Node, convert it. Recent
conversions: `check-language-server-registry.mjs` executes the editor's merged
`languageDefinitions` table; `check-code-intelligence.mjs` executes
`humanizeCapabilityId` and `allowedToolsFromCapabilityIds`.

## What runs where

| Runner | Executes |
| --- | --- |
| `pnpm test` | `test:reliability` (every Node guard, architecture ceilings, guard registry) then `pnpm -r test` |
| CI `node` job | `pnpm check`, `pnpm test`, `pnpm smoke:workbench`, `pnpm test:canvas-browser`, `pnpm release:check`, `pnpm site:check` |
| CI `rust` job | `cargo test --workspace`, CLI build, CLI packaging check |
| CI `tauri` job | frontend build, `cargo test --workspace`, debug `.app` bundle, native smoke |

- **Native smoke** (`scripts/run-native-smoke.mjs`, `pnpm smoke:native`) runs on
  the tauri job and launches the packaged debug app twice: the browser smoke
  (`GYRO_BROWSER_SMOKE_URL`) and the language-server smoke (`GYRO_LSP_SMOKE=1`).
  Both harnesses are `#[cfg(debug_assertions)]`-only, so the ok reports double
  as proof that the env-gated paths still exist and run.
- **Canvas preview** (`pnpm test:canvas-browser`) boots the Vite dev server when
  it is not already up, finds a Chromium-family browser, and drives
  `check-canvas-preview-browser.mjs` against the Canvas fixture headlessly.
- **Workbench smoke** (`pnpm smoke:workbench`) compares against
  `scripts/workbench-smoke-baseline.json`: a failure that is not recorded fails
  the run, and a recorded failure that starts passing is reported so it can be
  removed. The backlog can only shrink.

## Size ceilings

`scripts/architecture-size-baseline.json` caps the four largest sources —
`App.tsx`, `lib.rs`, `styles.css`, `surfaces.tsx` — and
`check-architecture-boundaries.mjs` fails when a file grows past its ceiling.
Ceilings ratchet down as domains are extracted; they do not ratchet up.

## Local reproduction

```sh
pnpm doctor && pnpm check && pnpm test
pnpm smoke:workbench
pnpm test:canvas-browser          # boots the dev server; needs a Chromium browser
cargo test --workspace

# Packaged-app smoke (heavier): build the debug bundle first.
pnpm --filter @gyro-dev/desktop tauri build --debug --bundles app --no-sign --ci
pnpm smoke:native
```
