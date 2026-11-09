# Backend split outcome and crate decision

Recorded 2026-11-09. Implementation checkpoints cover every planned phase.
Acceptance is scoped to the available Codex, Claude and DeepSeek setup.
Kimi, Antigravity and Ollama are unavailable and excluded from this run, as
confirmed by Wytze on 2026-11-09. Budget and disk space rule out subscriptions
or model downloads for this work. Historical probes remain evidence only.
The specific DeepSeek wrong-path failure was fixed in a follow-up; see the
[DeepSeek validation](../2026-11-09-deepseek-path-recovery/README.md). Broader
installed-app/frontend acceptance remains unverified.
No remote push, remote PR, new crate, model download or installed-app replacement
was performed.

## Delivered structure

| Plan part | Result / local checkpoint |
| --- | --- |
| 1.1–1.12: desktop domain extraction | Completed through `467a4ea1`; root now 122 lines, central test fixtures 593, wildcard baseline empty. All 197 handler registrations retained in the move. |
| 2a–2c: runner/host boundary | Registry and synchronous runner/host contracts, all six host-based adapters, legacy desktop dispatcher removed; through `52fa7d73`. |
| 3.1: Tauri-independent runtime | Actual adapters, registry, contracts, policy-parameterized tool loops/context helpers in `gyro-core::provider_runtime`; `37b5bc57`. Desktop supplies application effects. |
| 3.2: common Codex client | Shared spawn, bounded framing/writes, stderr drain and teardown across desktop chat/compaction/usage and CLI; `3117971e`. |
| 3.3: CLI host, separate behaviour change | `270a307a`; CLI uses the common registry and runners, terminal effects, guarded approvals and bounded headless file tools. Duplicate native loops removed. Dedicated local review branch `codex/backend-cli-runner-host`, range `3117971e..270a307a`. [Prepared review description](../2026-11-09-backend-cli-host/review.md); no remote PR created. |
| 3.4: measure and choose crate boundary | Keep providers in `gyro-core`, for the reasons and measurements below. No crate creation was needed. |

The detailed untracked handoff remains in `docs/backend-split/PLAN.md` and was
updated without staging its temporary helper scripts. Historical progress there
is superseded by its latest execution section. Pre-existing untracked browser
fixtures and Python cache files remain untouched.

## Current sizes

Counts are Rust source lines including tests/comments, from the completed 3.3
source. They do not imply equivalent build cost per line.

| File / tree | Baseline | Current |
| --- | ---: | ---: |
| Desktop `lib.rs` | 26,741 | 122 |
| Desktop central test fixtures | 9,744 | 593 |
| CLI `main.rs` | 7,367 | 5,602 |
| Desktop source tree | 98,374 | 92,833 |
| Core source tree | 77,560 | 88,326 |
| CLI source tree | 8,584 | 7,693 |
| Shared provider runtime | — | 10,543 across 29 files |

The baseline predates all split phases; feature/accounting work and new tests
also affect the totals. Moved tests live with their owning modules. Architecture
ceilings are ratcheted to the actual root sizes, and the desktop wildcard baseline
is empty. No Tauri/AppHandle dependency occurs in the shared runtime.

## Incremental checks and decision

Command: `cargo check -p gyro-desktop --locked`, warmed once first. Each sample
touches only the named file's mtime, leaving content unchanged. No concurrent
Cargo command or acceptance provider was running during measurement. The normal
installed Gyro and Cloud Test apps and local Ollama service remained in place.
Machine: Apple M1, 8 cores / 8 GB, arm64, rustc 1.96.1.

| Touched file | Current wall seconds | Median | Original median |
| --- | --- | ---: | ---: |
| Desktop `lib.rs` | 3.254, 2.049, 1.903 | 2.049 | 12.4 |
| Core `lib.rs` | 4.860, 4.037, 4.286 | 4.286 | 9.7 |
| Core Codex runner | 4.596, 4.492, 4.574 | 4.574 | not measured |

Source: [raw timing records](incremental-checks.json) and the
[original baseline](../2026-11-08-backend-split-baseline/README.md).
Every sampled check succeeded and the logs confirm the relevant crate was checked.
These are observed warm-cache timings on different sessions, not a controlled
causal estimate of the refactor's speedup. The original report treats changes
under about three seconds as noise. No hypothetical `gyro-providers` build was
measured, so no speedup for that crate can be claimed.

**Decision: retain `gyro-core::provider_runtime`.** The runtime is a bounded
10.5k-line module tree already shared by both hosts. Provider edits currently
check in about 4.6 seconds; the measured difference from touching desktop is about
2.5 seconds, within the baseline's stated noise band. The available data does not
justify the dependency/API churn of a new crate. A separate provider crate can be evaluated with
an actual comparative build if editing latency later warrants it; that would
require the plan's explicit user approval before creating the crate.

This completes the plan's decision step; it is not an unperformed crate split.

## Validation and acceptance limits

The final source (`270a307a`) passed locked workspace tests with four threads:
993 desktop / 1,019 core / 43 CLI unit tests, plus 25 CLI exit-code, 1 install-path,
2 new shared-API binary and core integration/doc targets. Desktop has 12 ignored
unit tests; core has 2 ignored unit and 2 ignored live Ollama integration tests.
Locked desktop all-targets checking passed with zero new warnings against the
original warning keys; CLI all-targets checking was warning-free. Formatting,
architecture and diff checks passed. The subsequent measurement/decision change
contains documentation only and reuses that byte-identical source validation.

Real CLI Codex, Claude and DeepSeek each passed exact guarded file application,
refusal, resume and Ctrl-C. Claude's native helper terminal-input hang was fixed
and the failed cohort retained. Codex manual compaction and remembered-keyword
native resume passed in the preceding shared-client checkpoint. The latest
desktop code cohort passed Codex and Claude fresh/resumed turns; DeepSeek's fresh
wrong-path failure and successful subsequent turn are retained alongside prior
successful cohorts.

Unavailable providers — excluded from the current acceptance scope:

- Kimi and Antigravity: Wytze has no subscription/access for these providers.
  No purchase, sign-in setup or paid test is required to finish this refactor.
- Ollama: Wytze has no downloaded model available for this work and lacks disk
  space for one. No download, model substitution or additional storage is required.
- Earlier harness results (Kimi HTTP 403, Antigravity sign-in prompt and an endpoint
  reporting `qwen3:0.6b`) are retained as historical probe results. The endpoint's
  model label does not establish that Wytze has a currently usable downloaded model.
  These results are not open setup tasks for Wytze and are not passing live tests.

Remaining limitations for the available setup:

- The recorded DeepSeek wrong-path failure is superseded by the
  [path-recovery fix](../2026-11-09-deepseek-path-recovery/README.md): final strict
  desktop code cases passed 4/4 with the correct file paths. One pending memory
  proposal during read-only setup remains a separate model-scope limitation; it
  was never applied.
  Earlier failures remain evidence; no approval allowlist or verifier was relaxed.
- Native harnesses use isolated stores/workspaces and verified debug PIDs. They
  do not establish frontend/window, installed-app, clean-machine or Linux
  acceptance. Non-macOS platform gates were reviewed; no absent target was installed.

Evidence: [CLI host and terminal matrix](../2026-11-09-backend-cli-host/README.md),
[desktop provider-host history](../2026-11-09-backend-provider-host/README.md).
These limitations prevent calling the full manual matrix accepted; they do not
leave another independent implementation phase in the plan outstanding.
