# Roadmap

## v0.1 Developer Preview

- macOS desktop app with workspace picker, chat sessions, file tree, diff view, terminal profiles, and settings.
- `gyro` CLI with interactive chat, `run`, `doctor`, `config`, and `app open/attach`.
- Shared SQLite session metadata and JSONL event logs.
- Local Unix-socket notification from CLI to app.
- BYOK provider configuration with Keychain storage.
- Signed and notarized direct macOS builds.
- Homebrew tap templates.

## v0.2 Reliability

- Real model-provider execution adapters.
- Approval UI for command execution and file edits.
- PTY-backed embedded terminal streaming.
- Signed updater manifest automation.
- Crash reporting with explicit opt-in.
- Workspace policy file through optional `gyro.toml`.

## v0.3 IDE Layer

- Deeper Monaco editor integration.
- Multi-file edit review.
- Git diff and branch workflow.
- VS Code extension prototype using `gyro-core`.
- Multi-agent/worktree experiments.

## Later

- Windows and Linux desktop support.
- Hosted team sync.
- Enterprise policy controls.
- Plugin ecosystem.
