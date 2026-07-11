# Product Readiness Audit

Audit date: 2026-07-11

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

| Area                      | Current state                                                                | Readiness                      |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Core storage and sessions | SQLite metadata, JSONL events, config, redaction, IPC                        | Ready                          |
| CLI control surface       | setup, doctor, run, resume, sessions, app handoff                            | Ready                          |
| Desktop terminals         | PTY, xterm, input, resize, stop, restart, restore, presets                   | Ready                          |
| Chat                      | Codex and Claude adapters, streaming, retry, resume, diagnostics             | Ready with provider setup      |
| Providers                 | OpenAI and Anthropic execute; xAI and Gemini report readiness only           | Partial by design              |
| IDE files                 | tree, Monaco, tabs, guarded read/write, stale-hash protection                | Ready                          |
| IDE search and Git        | rg search, status, stage, unstage, task discovery/run                        | Ready                          |
| LSP and debugger          | discovery and UI state; process orchestration scaffolded                     | Experimental                   |
| Diff review               | review state and file navigation; generic proposal apply contract incomplete | Partial                        |
| Tasks                     | local task state and real agent terminal dispatch                            | Ready for manual use           |
| Automations               | persistence, pause/resume, triage, manual agent launch                       | Partial until scheduler runner |
| Browser preview           | live local iframe, history, reload, device widths, external open             | Ready for manual preview       |
| Distribution              | dev build and release checks; production signing key absent                  | Not alpha-ready                |

## Highest-Risk Gaps

1. File-edit approval must become one atomic typed transaction from proposal to
   write, rejection, event log, diff state, and recovery.
2. Scheduled automations need a durable runner instead of relying on the app
   surface to record manual runs.
3. Provider onboarding needs a clean-machine acceptance test for both Codex and
   Claude.
4. LSP and DAP labels must remain experimental until process lifecycle,
   cancellation, and crash recovery are implemented.
5. Production distribution cannot be called ready while the updater key is a
   development placeholder.

## Acceptance Strategy

- TypeScript: UI and desktop typechecks plus workbench smoke assertions.
- Rust: workspace tests, focused terminal manager tests, formatting, and release
  configuration checks.
- Manual: Chat, CLI, and IDE route checks at desktop and compact widths; a real
  shell command; one Codex or Claude message; a guarded editor save; Git stage
  and unstage; task dispatch; automation manual run; and local preview load.
- Recovery: restart the app with persisted sessions, restored terminal panes,
  a stale editor buffer, a missing provider CLI, and an unavailable local URL.
