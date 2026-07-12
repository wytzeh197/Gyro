# Gyro

**A local-first agent workbench for coding with control.**

Gyro brings agent chat, terminals, files, diffs, approvals, tasks, and provider
state into one macOS workspace. Start in the app or the `gyro` CLI, then resume
the same local session from either surface.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/wytzeh197/Gyro/actions/workflows/ci.yml/badge.svg)](https://github.com/wytzeh197/Gyro/actions/workflows/ci.yml)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111111?logo=apple)](https://github.com/wytzeh197/Gyro)

[Download the latest alpha](https://github.com/wytzeh197/Gyro/releases/latest) ·
[Watch the launch film](docs/media/launch/gyro-launch-film.mp4) ·
[Read the architecture](docs/architecture.md) ·
[Contribute](CONTRIBUTING.md)

[![Watch the Gyro launch film](docs/media/launch/gyro-launch-poster.png)](docs/media/launch/gyro-launch-film.mp4)

> [!IMPORTANT]
> Gyro is currently a public alpha for macOS and is not recommended for
> production use. Preview downloads are not yet Apple-signed or notarized, so
> macOS may show a security warning. Only install a preview if you are
> comfortable testing software that can read files and run commands.

## Why Gyro

- **One run, three views.** Chat, CLI, and IDE surfaces share projects, sessions,
  providers, approvals, and history.
- **Local by default.** Session history, configuration, and worktrees stay on
  your Mac. Gyro does not send telemetry by default.
- **Visible control.** Commands and file changes follow an explicit approval
  policy, with diffs and run state kept in view.
- **Bring your own agent.** Codex CLI and Claude Code are the first executable
  adapters. Other providers remain clearly marked until their adapters exist.
- **Safe parallel work.** Create isolated Git worktrees for risky or concurrent
  runs without changing the default local workflow.

## Product Tour

<p align="center">
  <img src="docs/screenshots/chat-thread.png" alt="Gyro agent chat and run activity" width="49%">
  <img src="docs/screenshots/ide.png" alt="Gyro IDE workbench" width="49%">
</p>
<p align="center">
  <img src="docs/screenshots/cli-workbench.png" alt="Gyro CLI workbench" width="49%">
  <img src="docs/screenshots/diff-review.png" alt="Gyro diff review" width="49%">
</p>

## What Works Today

- Provider-backed conversations through local Codex CLI and Claude Code.
- Shared local sessions across Gyro.app and the `gyro` CLI.
- PTY terminals with profiles, restore, input, resize, stop, and restart.
- Workspace browsing, Monaco editing, guarded saves, search, Git status, tasks,
  tests, output, diagnostics, diffs, and browser preview.
- Provider setup checks, approval policies, redacted diagnostics, local
  worktrees, and persisted automations.

## Build From Source

### Requirements

- macOS 14 or newer
- Node.js 22 or newer
- pnpm 11 or newer (the workspace pins pnpm 11.7.0)
- Rust 1.78 or newer
- Xcode command line tools

### Run the desktop app

Run all commands from the repository root:

```bash
git clone https://github.com/wytzeh197/Gyro.git
cd Gyro
corepack enable
pnpm install --frozen-lockfile
pnpm doctor
pnpm check
cargo test --workspace
pnpm desktop:dev
```

To build and install a local app bundle for Finder or Dock testing:

```bash
pnpm desktop:install-local
```

This installs `Gyro.app` in `~/Applications`. Do not open or pin
`target/debug/gyro-desktop`; it is a raw development executable and expects the
Vite server to be running.

### Try the CLI

```bash
cargo run -p gyro-cli -- doctor
cargo run -p gyro-cli -- setup
cargo run -p gyro-cli -- run "Inspect this repository"
cargo run -p gyro-cli -- sessions
cargo run -p gyro-cli -- resume
```

Use `--worktree` with `gyro run` or `gyro app attach` when you explicitly want
an isolated Git worktree. Local mode is the default.

## How It Fits Together

```text
crates/gyro-core       Local engine, storage, policy, redaction, worktrees, IPC
crates/gyro-cli        Terminal interface and app handoff
apps/desktop           Tauri + React macOS application
packages/ui            Shared React surfaces and components
docs                   Architecture, privacy, release, and product notes
packaging/homebrew     Release-time formula and cask templates
```

Session metadata is stored in SQLite and events in append-only JSONL under:

```text
~/Library/Application Support/Gyro/
```

See [Architecture](docs/architecture.md) for the engine and data-flow model and
[Privacy](docs/privacy.md) for the local-data defaults.

## Project

Gyro is licensed under [Apache-2.0](LICENSE). Contributions use
[Developer Certificate of Origin](CONTRIBUTING.md#developer-certificate-of-origin)
signoff instead of a CLA.

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Governance](GOVERNANCE.md)
- [Release process](docs/release.md)
