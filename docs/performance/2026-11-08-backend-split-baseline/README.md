# Backend split baseline (Phase 0)

Recorded 2026-11-08, before any of the `lib.rs` split (Phase 1) or the
`ProviderRunner` trait (Phase 2) lands. Later phases compare against these
numbers.

The working tree had uncommitted work on `Heads/v0.1.1` (on top of `ca57e94d`)
when this was measured, so the sizes include it. At `ca57e94d` itself,
`apps/desktop/src-tauri/src/lib.rs` is 25,802 lines.

## Incremental `cargo check`

Command: `cargo check -p gyro-desktop --locked`. Each run came after a warm
check, with one file touched (mtime only, content unchanged) right before it.

| Touched file | Runs (wall clock, s) | Median |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/lib.rs` | 12.44, 12.80, 9.72 | 12.4 |
| `crates/gyro-core/src/lib.rs` | 9.80, 9.68 | 9.7 |

Machine: Apple M1, 8 cores, 8 GB, rustc 1.96.1. The installed Gyro.app was
running at the time, so treat differences under about 3 s as noise.

What to expect: cargo compiles one crate as a unit, so moving code into
modules inside `gyro-desktop` should leave these times about the same. The
times only drop when code moves into another crate (Phase 3).

## File sizes (lines)

| File | Lines | Ratchet ceiling |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/lib.rs` | 26,741 | 26,741 (was 31,217) |
| `apps/desktop/src-tauri/src/tests.rs` | 9,744 | 9,744 (new) |
| `crates/gyro-cli/src/main.rs` | 7,367 | 7,367 (new) |
| `crates/gyro-core/src/sessions.rs` | 5,602 | none |
| `crates/gyro-core/src/kimi_acp.rs` | 5,242 | none |
| `apps/desktop/src-tauri/src/session_browser.rs` | 4,087 | none |
| `crates/gyro-core/src/openai_compatible.rs` | 3,866 | none |
| `crates/gyro-core/src/agent_sessions.rs` | 3,646 | none |

| Crate source tree | Lines |
| --- | --- |
| `apps/desktop/src-tauri/src` | 98,374 |
| `crates/gyro-core/src` | 77,560 |
| `crates/gyro-cli/src` | 8,584 |

`lib.rs` holds 131 `#[tauri::command]` functions.

## Wildcard imports

There are 59 desktop modules outside test files that open with a top-level
`use super::*;` or `use crate::*;`. They are listed in
`scripts/architecture-wildcard-import-baseline.json`. Phase 1 is done when
that list is empty.

## Ratchets

`scripts/check-architecture-boundaries.mjs` runs in CI through `pnpm test`
(`test:reliability`) and fails when:

- a file listed in `scripts/architecture-size-baseline.json` grows past its ceiling;
- a desktop module not in the wildcard baseline adds a top-level glob import
  (test modules named `tests.rs` or `*_tests.rs`, and indented
  `mod tests { use super::*; }` blocks, are exempt);
- a file in the wildcard baseline stops using the glob or is moved, so the
  baseline must shrink along with the code.

When a split PR makes `lib.rs` smaller, lower its ceiling in the same PR.
