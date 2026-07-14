# Product Readiness Audit

Audit date: 2026-07-13

## Product Target

Gyro is a local-first coding-agent workbench for developers who want chat,
terminal agents, editor context, diffs, Git state, and approvals in one calm
desktop surface. The immediate target is a dependable private alpha for daily
personal use on macOS, not full VS Code parity or multi-agent orchestration.

## Design Audit

Strengths:

- The shared shell already gives Chat, CLI, and IDE stable navigation.
- Core surfaces favor compact operational layouts over marketing composition.
- Status vocabulary and provider identity are visible across most workflows.
- Monaco and xterm remain in the desktop boundary, while shared UI stays mostly
  presentational.

Issues found:

- Several generations of CSS overrides produced inconsistent border contrast,
  radius, shadow, and animation timing.
- The neutral palette lacked enough interaction and state color, so active,
  running, waiting, successful, and failed states could read too similarly.
- Some cards and panels were visually heavier than their information hierarchy.
- A handful of visible controls were placeholders or routed only to a toast.
- Browser preview represented a simulated state rather than rendering the URL.

Polish direction applied:

- Half-pixel hairlines and quieter panel edges.
- 80 ms interaction motion and 130 ms surface motion with one spring-like ease.
- Smaller shared radii and reduced decorative shadows.
- Neutral graphite surfaces with blue interaction accents plus green, amber,
  and red operational states.
- Real local iframe preview, smaller CLI chrome, and working overflow actions.
- Unsupported controls are omitted or visibly unavailable rather than fake.

## Functional Readiness Matrix

| Area                      | Current state                                                                                                                                                                                              | Readiness                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Core storage and sessions | SQLite metadata, JSONL events, config, redaction, IPC                                                                                                                                                      | Ready                                                                            |
| CLI control surface       | chat/run/resume, setup/doctor, sessions/config, approvals, app handoff, JSON, completions                                                                                                                  | v0.2 core; hardening remains                                                     |
| Desktop terminals         | PTY, xterm, input, resize, stop, restart, restore, presets                                                                                                                                                 | Ready                                                                            |
| Chat                      | Codex and Claude adapters, streaming, retry, resume, diagnostics                                                                                                                                           | Ready with provider setup                                                        |
| Providers                 | OpenAI and Anthropic execute; xAI and Gemini report readiness only                                                                                                                                         | Partial by design                                                                |
| IDE files                 | tree, Monaco, tabs, guarded read/write, stale-hash protection                                                                                                                                              | Ready                                                                            |
| IDE search and Git        | rg search, status, stage, unstage, task discovery/run                                                                                                                                                      | Ready                                                                            |
| LSP and debugger          | discovery and UI state; process orchestration scaffolded                                                                                                                                                   | Experimental                                                                     |
| Diff review               | review state, file navigation, durable proposals, guarded provider transactions, and restart recovery                                                                                                      | Implemented for supported text actions; acceptance remains                       |
| Tasks                     | local task state and real agent terminal dispatch                                                                                                                                                          | Ready for manual use                                                             |
| Automations               | backend scheduler, resume wakeups, renewable durable leases, real provider sessions, pause cancellation, atomic recovery, backoff, machine-enforced stop verdicts, and private local outcome notifications | Functional locally; physical sleep/wake and installed-provider acceptance remain |
| Browser preview           | live local iframe, history, reload, device widths, external open, bounded loopback console/page errors, private native PNG capture with retention                                                          | Ready for local preview; installed capture acceptance pending                    |
| Distribution              | real GitHub updater key/manifest/signatures and a tagged draft workflow that now requires Apple credentials                                                                                                | Future releases fail closed; published alpha acceptance remains incomplete       |

## Highest-Risk Gaps

1. OpenAI and Anthropic tool callbacks now reach typed Gyro approvals in the CLI
   and desktop Chat. Accepted Codex file sets and Claude Write/Edit/MultiEdit
   actions use the shared hash-guarded, journaled transaction; notebook and
   binary edits fail closed. Installed-provider acceptance and approval restore
   still need clean-machine proof.
2. Scheduled automations now run in the desktop backend even when the window is
   hidden, create normal approval-aware Gyro sessions, recover expired leases,
   and back off failures. Resume events now wake the scheduler without a lost-signal
   race, and simulated forward clock jumps claim one missed run. Physical sleep/wake,
   physical installed-notification delivery still needs release proof. Simulated
   backward clock correction now keeps due work visible without duplicate claims,
   and lease heartbeats cannot shorten an owned expiry. Native permission state and a user-triggered test are available
   under Settings > Permissions; background runs never trigger a surprise prompt.
   Long-running provider and approval waits now renew only their
   still-owned lease; process loss still falls through to expiry recovery.
   Stop-condition
   verdicts now fail closed, persist in run history, and atomically complete the schedule;
   the hidden verdict protocol still needs real-provider acceptance proof.
3. Provider onboarding needs a clean-machine acceptance test for both Codex and
   Claude.
4. LSP and DAP labels must remain experimental until process lifecycle,
   cancellation, and crash recovery are implemented.
5. The updater trust path is configured with a real committed public key and
   signed GitHub manifest, but the currently published alpha DMGs are only
   ad-hoc/linker-signed: they fail strict code-signing and Gatekeeper checks and
   have no stapled notarization ticket. The current tagged workflow intentionally
   builds these unsigned public-alpha artifacts on GitHub while requiring Tauri
   updater signatures. Per-tag workflow concurrency and a draft-only mutation
   guard prevent reruns from overwriting an already published release. Apple
   Developer ID signing and notarization remain future stable-release work, and
   both architectures still need clean-machine acceptance before distribution
   can be called ready.

## CLI Roadmap Audit

Current evidence against the [CLI Surface Roadmap](../ROADMAP.md#cli-surface-roadmap):

| Requirement                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared command grammar                | `chat`, `run`, `resume`, `sessions`, `setup`, `doctor`, `config`, `approvals`, and `app` are implemented in `gyro-cli`                                                                                                                                                                                                                                                                                                                  | Implemented                                                                                                                                                                               |
| Required versus optional remediation  | Shared doctor checks expose `required` and a redaction-safe `next` action; human doctor output labels capability scope and setup reuses the same guidance                                                                                                                                                                                                                                                                               | Implemented                                                                                                                                                                               |
| Human and versioned machine output    | Human output remains the default and session/setup/doctor rows wrap to terminal width; automation paths use `gyro.cli.v1`; real-binary coverage exercises 60-column Unicode plus `NO_COLOR`, piped Chat NDJSON, sessions, setup, doctor, config, approvals, completions, and app handoff                                                                                                                                                | Implemented for current public commands; release-to-release golden compatibility still needs a published baseline                                                                         |
| Provider execution and readiness      | Codex runs through its app-server protocol; Claude runs through stream JSON with a Gyro MCP permission bridge; setup uses the shared provider health service; explicit profiles cannot bypass a disabled shared provider; structured auth/network failures retain the session and map to `provider-unavailable` with the next command                                                                                                   | Implemented for supported executable providers                                                                                                                                            |
| Explicit workspace and durable resume | Commands accept explicit workspace paths and persist workspace, branch, worktree, provider, model, approval, and resume metadata in the shared store                                                                                                                                                                                                                                                                                    | Implemented                                                                                                                                                                               |
| Terminal-native approvals             | Codex app-server and Claude permission-tool callbacks create durable per-action approval events; interactive runs decide each gated action, non-interactive runs fail closed without `--approve`, and accepted Codex file sets plus Claude Write/Edit/MultiEdit actions use the shared atomic transaction before native reapply is suppressed                                                                                           | Implemented for supported UTF-8 text actions; notebook/binary edits fail closed                                                                                                           |
| Signal-safe recovery                  | Cancellation is active before provider startup and throughout Codex app-server work; a real PTY test proves Ctrl-C exits 130 at an action approval before that action runs; pre-cancelled commands never spawn; interrupted writes use a pre-commit Application Support journal; Codex and Claude persist resumable identity before a turn can crash and real-binary fixtures cover crash-resume plus one-shot stale-cursor replacement | Implemented at protocol boundaries; authenticated clean-machine, offline, and approval-restore proof remains                                                                              |
| Stable exit categories                | Typed failures define invalid input, unavailable provider, approval rejection, execution failure, cancellation, and internal failure; isolated subprocess tests assert JSON and process codes, including structured Claude authentication failure, disabled-provider policy, approval lookup, and decision failures                                                                                                                     | Implemented; extend fixtures as commands are added                                                                                                                                        |
| App handoff                           | Open and attach share the session store and a versioned IPC acknowledgement; compatible handoff is asserted from the real binary, incompatible app/CLI pairs fail closed with both versions and recovery guidance, and live probes remove an unchanged refused Unix socket while preserving non-socket or replaced paths                                                                                                                | Implemented, including compatible, incompatible, and stale-socket real-binary fixtures                                                                                                    |
| Installable CLI                       | `gyro --version`, zsh/bash/fish completion generation, Homebrew completion installation, and explicit CLI/app compatibility behavior are implemented; the tagged release matrix now builds native Apple Silicon and Intel archives, emits deterministic manifests and checksum sidecars, rejects corrupted archives, runs the installed CLI from an isolated home, and generates `SHA256SUMS` plus a real-checksum Formula              | Implemented in release automation and locally verified on Apple Silicon; a tagged draft, generated tap Formula, and clean Apple Silicon/Intel hardware acceptance remain release evidence |

Provider interception direction: gated OpenAI Chat and CLI runs use the
installed Codex app-server protocol and handle typed
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and
permission callbacks with explicit decisions. Claude CLI and desktop Chat runs
use the permission-prompt MCP boundary, backed by hidden Gyro stdio helpers;
the desktop helper sends versioned requests to the running app over its
user-only local socket. Configured permission-bypass flags fail closed. Neither
path parses provider prose to infer approval state. Accepted Codex file
callbacks are decoded into the shared
workspace-bound, hash-guarded transaction; after Gyro applies the set, the
adapter declines the provider-native reapply while allowing the turn to
continue. Claude Write/Edit/MultiEdit permission requests are converted to the
same transaction by the hidden Gyro MCP bridge; it returns a denial only after
Gyro has already applied the reviewed file change, preventing a second write.

The v0.2 exit gate is not yet proven. The next hardening work is broader
notebook/binary mutation policy plus authenticated provider-crash, restart,
approval-restore, and stale-resume proof on a clean machine. A local Claude Max
profile was discoverable during the 2026-07-14 probe, but the live request
returned HTTP 401 before any tool callback, so that evidence is not counted as
provider acceptance. The CLI now reports that response as
`provider-unavailable`, recommends `claude auth login`, and preserves the exact
Gyro session for `gyro resume`; the remaining blocker is the provider account,
not a hidden or misclassified CLI failure.

## Acceptance Strategy

- TypeScript: UI and desktop typechecks plus workbench smoke assertions.
- Rust: workspace tests, focused terminal manager tests, formatting, and release
  configuration checks.
- Manual: Chat, CLI, and IDE route checks at desktop and compact widths; a real
  shell command; one Codex or Claude message; a guarded editor save; Git stage
  and unstage; task dispatch; one backend automation run plus pause/cancel; and
  local preview load.
- Recovery: restart the app with persisted sessions, restored terminal panes,
  a stale editor buffer, a missing provider CLI, and an unavailable local URL.
