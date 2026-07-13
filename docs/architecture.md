# Architecture

Gyro uses one engine and multiple surfaces.

## Surfaces

- `gyro` CLI for terminal-first workflows.
- Gyro.app for a native macOS coding workspace.
- Future IDE integrations should call the same core engine instead of reimplementing session behavior.

The CLI is a terminal-native control plane, not a full TUI dashboard. Its
`chat`, `run`, and `resume` workflows execute supported provider CLIs through
the same `gyro-core` process lifecycle used by the desktop adapters. Run intent,
profile/model hints, approval state, output, cancellation, resume identity,
workspace/worktree context, and app handoff metadata use the shared session
store.

## Core Responsibilities

`gyro-core` owns:

- User data paths.
- Session metadata in SQLite.
- Append-only JSONL session event logs.
- Durable event appends followed by SQLite metadata updates, plus bounded tail reads for long sessions.
- Config loading and saving.
- Approval policy.
- Secret redaction.
- Workspace path boundary checks.
- Git worktree creation for explicitly isolated sessions.
- macOS Keychain access for provider keys.
- Local IPC payloads for CLI-to-app notifications.
- Bounded subprocess execution, process-group cleanup, timeouts, streaming
  output, and shared cancellation tokens.
- Provider readiness, provider-owned authentication diagnostics, and redacted
  remediation metadata shared by the desktop app and CLI.

## Data Flow

1. A surface opens a workspace.
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
proposals should use typed payloads so desktop, CLI, and future IDE surfaces can
render the same state.

Live provider events carry a turn-local monotonic sequence. The desktop orders
out-of-order events, discards duplicates, bounds pending gaps, and coalesces text
deltas before updating React state. Terminal events close the turn ordering
state so a repeated completion or cancellation cannot render twice.

Machine-readable CLI responses use the `gyro.cli.v1` envelope. Runtime failures
use stable categories and exit codes so scripts can distinguish invalid input,
provider unavailability, rejected approval, execution failure, cancellation,
and internal failure.

The supported desktop and CLI adapters route OpenAI through the local Codex CLI
and Anthropic through Claude Code. Both surfaces use the shared bounded process
runner, provider-stream parser, and provider-health service. xAI and Gemini are readiness-only in V1:
health checks can report setup state, but execution returns a blocked run
instead of pretending to start. Provider credentials stay outside Gyro in
provider CLIs, SDKs, environment variables, Keychain references, or
provider-owned files.

Provider diagnostics are redacted and metadata-only: provider id, model id,
timing, retry count, resumed/not-resumed state, timeout/failure reason, and
sanitized output summary. The diagnostics export command bundles config summary,
provider health, recent provider-run diagnostics, and session metadata without
secrets or full message bodies.

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
worktrees/            Gyro-managed isolated Git worktrees
gyro.sock             Runtime-only CLI-to-app socket
```

Gyro does not write metadata into user repositories by default. A future optional `gyro.toml` may define workspace-specific policies.

## Desktop Backend

The Tauri backend exposes commands for session listing, local/worktree session creation, event reads/writes, config loading/saving, and shallow workspace file listing.

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
