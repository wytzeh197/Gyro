# Architecture

Gyro uses one engine and multiple surfaces.

## Surfaces

- `gyro` CLI for terminal-first workflows.
- Gyro.app for a native macOS coding workspace.
- Future IDE integrations should call the same core engine instead of reimplementing session behavior.

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
4. Session metadata is updated in SQLite.
5. The desktop app subscribes to local IPC notifications so CLI-created sessions can appear in the app.
6. Command and file-edit execution must pass policy gates before mutation.

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
