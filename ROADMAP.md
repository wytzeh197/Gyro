# Roadmap

Gyro's roadmap is alpha-trust-first: make one local coding run clear, inspectable,
and safe before expanding into broader parallel-agent workflows.

## v0.1 Foundation

Current repository foundation:

- Rust core crate for user paths, sessions, local storage, config, approval policy, redaction, Keychain access, app IPC, and worktree creation.
- `gyro` CLI with interactive chat, one-shot `run`, `resume`, `sessions`, `setup`, `doctor`, `config`, and `app open/attach`.
- Tauri + React macOS desktop shell with workspace selection, chat sessions, file preview, diffs, terminal profiles, providers, settings, tasks, and automations surfaces.
- Shared SQLite session metadata and append-only JSONL session event logs.
- Local Unix-socket notification so CLI-created sessions can open in Gyro.app.
- Homebrew, release, launch, security, governance, and privacy documentation.

## v0.2 Alpha Trust

Make the first trusted local agent run excellent:

- Real provider execution adapters for the supported CLI/provider profiles.
- Approval UI for command execution, file edits, and sensitive context expansion.
- PTY-backed embedded terminal streaming with reliable stdin, output, restore, stop, and restart behavior.
- Reliable diff review for proposed edits, including accept/reject flows that preserve local Git state.
- Provider setup that makes auth, health, model choice, command profile readiness, and CLI resume state obvious.
- Signed and notarized macOS install path, Homebrew packaging, release checks, and signed updater manifest automation.
- Crash reporting only as an explicit opt-in, with clear privacy copy.
- Optional workspace policy file through `gyro.toml` for repo-specific guardrails.

## v0.3 Parallel Workbench

Scale from one trusted run to many coordinated runs:

- Multi-project and multi-thread navigation that keeps each repo, branch, provider, and run state distinct.
- Worktree-native parallel tasks with safe branch naming, visible isolation, and cleanup guidance.
- Git review workflow for branch creation, commit, push, and pull request preparation from inside Gyro.
- Provider handoffs that carry enough context for a second agent or model to continue the same work.
- Automations for recurring local checks, heartbeat prompts, and follow-up agent runs with visible triage.
- Browser preview and local service workflows that make app verification part of the same workbench.

## v0.4 IDE And Ecosystem

Deepen the workspace without weakening the local-first core:

- Deeper Monaco/editor integration for multi-file reading, navigation, and review.
- VS Code extension prototype using `gyro-core` instead of duplicating session behavior.
- Skills and plugin interfaces for repeatable local workflows.
- Windows and Linux desktop support after macOS alpha reliability is strong.
- Hosted team sync, enterprise policy controls, and support offerings only when they preserve the open local core.
