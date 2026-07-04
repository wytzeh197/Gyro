# Gyro

Gyro is an open-source, local-first coding agent workspace. It starts as a macOS desktop app plus a CLI, with a shared engine that can later power IDE integrations.

The first product goal is simple: open a repo, start an agent session, keep the terminal and chat in one workspace, review proposed edits, approve commands, and continue the same session from either the CLI or Gyro.app.

## Status

Gyro is pre-alpha. This repository contains the v0.1 foundation:

- Rust core crate for sessions, local storage, config, approval policy, redaction, Keychain access, and app IPC.
- `gyro` CLI crate with interactive sessions, one-shot task recording, app open/attach commands, doctor checks, and config management.
- Tauri + React desktop shell for macOS.
- Shared React UI package for chat, files, diffs, terminal profiles, and settings.
- Release, Homebrew, security, governance, and launch documentation.

## Repository Layout

```text
crates/gyro-core       Shared local-first engine
crates/gyro-cli        gyro command-line interface
apps/desktop           Tauri desktop app
packages/ui            Shared React components
docs                   Architecture, release, launch, privacy, and packaging notes
packaging/homebrew     Homebrew formula and cask templates
```

## Requirements

- macOS 14 or newer for the first supported desktop target.
- Node.js 22 or newer.
- pnpm 11 or newer.
- Rust 1.78 or newer.
- Xcode command line tools for signed macOS builds.

## Development

```bash
cd "/Users/wytzehemrica/Documents/Gyro"
pnpm install
pnpm doctor
pnpm check
cargo test --workspace
pnpm desktop:dev
```

Always run project commands from the repository root. Running `pnpm --filter ...` from `~` can make pnpm scan too much of your home directory and exhaust Node's heap.

If `cargo` is missing, install Rust first:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
cargo --version
```

The desktop app is launched through the checked root script:

```bash
pnpm desktop:dev
```

`tauri dev` starts Vite through a direct `pnpm exec vite` command. Do not change the Tauri `beforeDevCommand` to the root `pnpm dev` script; that can recurse into another Tauri process and make the app repeatedly close and relaunch.

The CLI binary is defined in `crates/gyro-cli`:

```bash
cargo run -p gyro-cli -- doctor
cargo run -p gyro-cli -- run "Inspect this repo"
cargo run -p gyro-cli -- run --worktree "Try the safer refactor path"
cargo run -p gyro-cli -- app open
```

## CLI And App Session Sharing

Gyro stores session metadata in SQLite and session events as append-only JSONL under the user's application support directory:

```text
~/Library/Application Support/Gyro/
```

Both the CLI and desktop app use the same store. When Gyro.app is running, the CLI notifies it through a local Unix socket so CLI-created sessions can open inside the app.

Use `--worktree` on `gyro run` or `gyro app attach` to create an isolated Git worktree under Gyro's application support directory before opening the session:

```bash
cargo run -p gyro-cli -- run --worktree "Prototype the terminal restore flow"
cargo run -p gyro-cli -- app attach --worktree --branch gyro/restore-flow
```

Worktree mode requires the selected workspace to be inside a Git repository. Local mode remains the default.

## Open Source

Gyro is licensed under Apache-2.0. Contributions use Developer Certificate of Origin signoff instead of a CLA.

See:

- [Architecture](docs/architecture.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Roadmap](ROADMAP.md)
- [Release process](docs/release.md)
