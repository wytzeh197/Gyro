# Architecture

Gyro uses one engine across its desktop surfaces and terminal entrypoints.

## Surfaces

- **Sessions** in Gyro.app for Chat conversations and app-hosted subscription
  CLI panes such as Codex CLI and Claude Code.
- **Workspace** in Gyro.app for files, editing, Git, diffs, tests, diagnostics,
  terminals, and browser evidence.
- The standalone `gyro` CLI for terminal-first control and automation.
- Future editor integrations should call the same core engine instead of
  reimplementing session behavior.

The CLI is a terminal-native control plane, not a full TUI dashboard. Its
`chat`, `run`, and `resume` workflows execute supported provider CLIs through
the same `gyro-core` process lifecycle used by the desktop adapters. Run intent,
profile/model hints, approval state, output, cancellation, resume identity,
workspace/worktree context, and app handoff metadata use the shared session
store.

## Core Responsibilities

`gyro-core` owns:

- User data paths.
- Session metadata in SQLite (WAL, process-local connection reuse in the
  desktop app, schema versioning to avoid re-migration on every open).
- Append-only JSONL session event logs with per-event fsync; JSONL is the source
  of truth for chat history, while SQLite indexes sessions, turn status, and
  mutation proposals.
- Durable event appends followed by SQLite metadata updates, plus bounded tail
  reads for long sessions. Opening a chat loads the recent event window; older
  history is available via reverse pagination (`read_events_before`) so a
  month-old thread stays fully readable without parsing the entire log at once.
- A rebuildable SQLite index tracks goal, plan, and submitted-mode events past
  the recent transcript window. Reads catch the index up from JSONL; the UI
  derives current context from those events without rendering old transcript
  pages. JSONL remains the source of truth.
- Chat retention is local and unbounded by age: sessions stay until the user
  deletes them. Closing a chat pane while a provider turn (or model-owned
  terminal) is live asks Stop and close vs Keep running so background work is
  never an invisible power drain.
- Config loading and saving.
- Approval policy.
- Secret redaction.
- Workspace path boundary checks.
- Fast workspace readiness checks at turn start: folder availability, project
  kind, and a bounded Git brief, reused for a few seconds so repeated sends
  do not respawn Git. A missing project fails closed before a provider is
  spawned. A compact briefing is injected so the first model token does not
  wait on a tool round-trip. The desktop marks a turn running before the
  workspace-context JSONL append so fsync cannot hide the first activity.
- Git worktree creation for explicitly isolated sessions.
- macOS Keychain access for provider keys.
- Local IPC payloads for CLI-to-app notifications.
- Bounded subprocess execution, process-group cleanup, timeouts, streaming
  output, and shared cancellation tokens.
- Provider readiness, provider-owned authentication diagnostics, and redacted
  remediation metadata shared by the desktop app and CLI.

## Data Flow

1. A surface or terminal entrypoint opens a workspace.
2. `gyro-core` creates or loads a session.
3. User messages, system events, command requests, and file-edit proposals are appended to the session JSONL log.
4. CLI execution metadata includes `profileId`, `model`, `workspaceMode`,
   `branch`, `worktreeName`, run/attempt identity, status, and a resume command
   without a separate session model.
5. Session metadata is updated in SQLite.
6. The desktop app subscribes to local IPC notifications so CLI-created sessions can appear in the app; the CLI reports success only after the app acknowledges the notification.
7. Command and file-edit execution must pass policy gates before mutation.

## Model Harness Contract

Gyro is a model harness: it launches, observes, controls, and resumes provider
runs through one local contract. V1 keeps the existing session table and treats
`turnId` as the run id for provider and CLI handoff events.

Shared harness payloads live in `gyro-core` and serialize into the existing
append-only JSONL log. The V1 run statuses are `queued`, `running`, `waiting`,
`blocked`, `done`, `failed`, and `cancelled`. Provider runs, provider
diagnostics, approval requests, terminal requests, file-edit proposals, and diff
proposals should use typed payloads so Sessions, Workspace, the standalone CLI,
and future editor integrations can render the same state.

Live provider events carry a turn-local monotonic sequence. The desktop orders
out-of-order events, discards duplicates, bounds pending gaps, and coalesces text
deltas before updating React state. The first visible token is flushed
immediately; later deltas still coalesce on the stream interval so a fast model
does not wait a full coalescing window before anything appears. Terminal events
close the turn ordering state so a repeated completion or cancellation cannot
render twice.

Machine-readable CLI responses use the `gyro.cli.v1` envelope. Runtime failures
use stable categories and exit codes so scripts can distinguish invalid input,
provider unavailability, rejected approval, execution failure, cancellation,
and internal failure.

The supported desktop and CLI adapters route OpenAI through the local Codex CLI,
Anthropic through Claude Code, Kimi through its ACP runtime, and xAI, Gemini,
Cursor, and OpenCode through their ACP-compatible local CLIs. Cursor and
OpenCode remain experimental. Both surfaces use the shared bounded process
runner, provider-stream parser, provider-health service, and backend-owned
provider capability manifest. The desktop reads that manifest at startup; its
checked-in catalog is an offline preview fallback rather than runtime truth.
Provider credentials stay outside Gyro in provider CLIs, SDKs, environment
variables, Keychain references, or provider-owned files; the direct-HTTP runners
read a key in-process for the duration of a call rather than exporting it.

Ollama is the exception to the CLI/ACP adapter family: Gyro talks directly to
its loopback HTTP API, streams tokens as they arrive, and keeps conversation
continuity in the local session log instead of storing an Ollama session
cursor. The default endpoint is `http://localhost:11434/api`; URL validation
permits only loopback HTTP hosts, does not follow redirects, and rejects URL
credentials. Model discovery stays ephemeral. Models that advertise native
function calling receive the desktop capability broker and approval policy,
filtered to the tools the current run mode can actually grant; unverified
models are chat-only. Attachments are rejected for this provider in V1.
ACP providers fail the turn rather than silently dropping the Gyro tool
bridge. Quiet provider processes are not treated as finished: desktop chat
disables process inactivity, and CLI ACP/Codex inactivity cannot undercut
the selected run deadline. Transient network errors retry twice with short
backoff; hard timeouts and cancellations do not.

Workspace-capable chat turns carry the selected project and instructions to
inspect, edit, and verify through Gyro tools, including resumed sessions. Plan
and Council retain their existing action limits. File-edit results return
bounded proposal metadata and an explicit pending/applied status; file bodies
remain in the proposal store so a large successful edit cannot overflow the
tool response budget. Capability event subscriptions remain active when the
session list changes, and IDE evidence is sent with its snapshot's project key.

The stdio capability and permission bridges use a bounded worker queue so a
long tool call does not block health checks or tool discovery. Cancelled queued
calls are discarded before execution; running calls retain the broker's run
cancellation and approval checks. Responses must match the request's call and
capability identity and carry a valid terminal outcome. Transport failures do
not automatically replay workspace actions.

A research sub-agent is dispatched through that same harness rather than beside
it: `gyro_research` starts a fresh session on a read-only Plan turn, and the
child holds a run control of its own for the whole turn, so its capability
context, broker checks, approvals, usage ledger rows, and timeline behave
exactly like any other provider run. The child's control follows the calling
chat's stop token one way — stopping the chat stops the research instead of
leaving it spending in the background, while stopping the research alone leaves
the chat running. The parent's tool call blocks until the child reports and only
the child's final message returns to it; the child session is kept so the
research stays auditable, and it records the chat that started it. That record
is what keeps a sub-agent run from reading as a chat of its own: the chat list,
the "latest chat" lookup that resume and startup use, and the menu bar's chat
outcomes all leave it out, and the call card that reports the research is what
opens the transcript. Deleting the chat that started the research deletes it
too, so a hidden run never outlives the conversation it belongs to.

The OpenAI-compatible API runner is the third adapter family. Gyro ships
DeepSeek, Mistral, and OpenRouter presets, and a user can add any other endpoint
as a `custom:<slug>` provider. All of them share one HTTPS client in `gyro-core`
(`openai_compatible.rs`) that streams SSE deltas, accumulates tool calls which
arrive as JSON-string fragments, and reads the streamed usage block. The key is
read in-process from the environment or the Keychain and sent as a Bearer
header; it is never injected into a child process and never placed in the URL.
The transport rule differs from Ollama's deliberately: plain HTTP stays legal
for loopback hosts (LM Studio, vLLM, llama.cpp), every other host must be HTTPS,
and a redirect is refused so a Bearer token cannot be walked to a host the user
did not configure. Tool calls made through this runner cross the same capability
broker, approval policy, and audit path as a local model's, and stream through
the same events. These providers are experimental in V1, and the standalone CLI
can configure them while its chat loop still runs only the subprocess adapters.
See `docs/api-key-providers.md`.

Provider diagnostics are redacted and metadata-only: provider id, model id,
timing, retry count, resumed/not-resumed state, timeout/failure reason, and
sanitized output summary. The diagnostics export command bundles config summary,
provider health, recent provider-run diagnostics, and session metadata without
secrets or full message bodies.

## Architecture artifact status

- This document describes current, normative architecture.
- `docs/vision.md` defines product principles, not runtime proof.
- `docs/roadmap.md` is forward-looking and may contain unshipped work.
- `docs/releases/` records historical release behavior.
- `docs/internal/` contains local planning and is not a public architecture
  contract.
- Runtime registries, executable tests, and current-source verification win when
  prose conflicts with the implementation. Any discovered conflict should still
  be repaired here rather than left as permanent tribal knowledge.

## Local Storage

Default macOS location:

```text
~/Library/Application Support/Gyro/
```

Important files:

```text
gyro.sqlite3          Session metadata
config.json           Local user config
sessions/*.jsonl      Append-only session event logs
mutation-journals/    In-flight multi-file apply journals and applied markers
worktrees/            Gyro-managed isolated Git worktrees
gyro.sock             Runtime-only CLI-to-app socket
```

Multi-file provider applies write a journal, commit files, record an applied
event, fsync a sibling `.applied` marker, then finalize. Startup recovery prefers
the marker over a capped event-window scan so a long session cannot cause a
false rollback after commit.

Gyro does not write metadata into user repositories by default. A future optional `gyro.toml` may define workspace-specific policies.

## Desktop Backend

The Tauri backend exposes commands for session listing, local/worktree session creation, event reads/writes, config loading/saving, and shallow workspace file listing.

The automation scheduler reserves provider capacity before claiming a durable
lease. It can run two due automations at once when their workspace paths differ;
runs targeting the same checkout wait for one another. A busy interactive app
leaves due work queued instead of recording a failed automation run.

At startup it binds the local Unix socket. The CLI sends newline-delimited JSON
notifications to this socket when a session should open or attach in Gyro.app.
The app replies with `ok`; both sides use bounded read and write timeouts so a
stale socket cannot be mistaken for a successful handoff.

## Security Boundaries

- Provider keys live in Keychain.
- Logs redact common API key and token patterns.
- File access must stay inside the selected workspace unless the user explicitly approves another path.
- Terminal commands and file writes require approval by default.
- Signed updates are mandatory for direct app installs.
