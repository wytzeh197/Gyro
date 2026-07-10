# Architecture

Gyro uses one engine and multiple surfaces.

## Surfaces

- `gyro` CLI for terminal-first workflows.
- Gyro.app for a native macOS coding workspace.
- Future IDE integrations should call the same core engine instead of reimplementing session behavior.

The CLI v1 surface is an agent launcher and control plane, not a full terminal
dashboard. It records trusted local run intent, profile/model hints, approval
state, workspace/worktree context, and app handoff metadata in the shared
session store. External agent execution remains explicit through configured CLI
profiles and future provider adapters.

## Core Responsibilities

`gyro-core` owns:

- User data paths.
- Session metadata in SQLite.
- Append-only JSONL session event logs.
- Config loading and saving.
- Approval policy.
- Secret redaction.
- Workspace path boundary checks.
- Git worktree creation for explicitly isolated sessions.
- macOS Keychain access for provider keys.
- Local IPC payloads for CLI-to-app notifications.

## Data Flow

1. A surface opens a workspace.
2. `gyro-core` creates or loads a session.
3. User messages, system events, command requests, and file-edit proposals are appended to the session JSONL log.
4. CLI launch metadata can include `profileId`, `model`, `workspaceMode`, `branch`, `worktreeName`, and a resume command without requiring a database migration.
5. Session metadata is updated in SQLite.
6. The desktop app subscribes to local IPC notifications so CLI-created sessions can appear in the app.
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

The desktop provider adapter registry currently routes OpenAI chat through the
local Codex CLI and Anthropic chat through Claude Code. xAI and Gemini are
readiness-only in V1: health checks can report setup state, but chat execution
returns a blocked run instead of pretending to start. Provider credentials stay
outside Gyro in provider CLIs, SDKs, environment variables, Keychain references,
or provider-owned files.

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

At startup it binds the local Unix socket. The CLI sends JSON notifications to this socket when a session should open or attach in Gyro.app.

## Security Boundaries

- Provider keys live in Keychain.
- Logs redact common API key and token patterns.
- File access must stay inside the selected workspace unless the user explicitly approves another path.
- Terminal commands and file writes require approval by default.
- Signed updates are mandatory for direct app installs.
