# Gyro

Gyro is an open-source, local-first agent workbench for trusted coding runs. It starts as a macOS desktop app plus a CLI, with a shared Rust engine that can later power IDE integrations.

The first product goal is simple: open a repo, start or attach an agent session, keep chat, terminal, files, diffs, approvals, and provider state in one workspace, and continue the same run from either the CLI or Gyro.app.

Gyro's design center is trust and control. Device access, sessions, and history stay local by default, provider credentials live in the OS keychain, commands and file edits are approval-gated, and risky or parallel work can move into isolated Git worktrees.

## Status

Gyro is pre-alpha and has not launched v0.1.0 yet. The current repository state
is pre-launch foundation work for the first private/developer preview:

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
git clone https://github.com/wytzeh197/Gyro.git
cd Gyro
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

For local app testing outside the dev server, build and open the macOS app
bundle instead:

```bash
pnpm desktop:bundle
open target/release/bundle/macos/Gyro.app
```

To install a fresh local copy for Finder or Dock testing:

```bash
pnpm desktop:install-local
```

Do not pin or open `target/debug/gyro-desktop` from Finder or the Dock. That is
the raw debug executable, not `Gyro.app`, and it can open a blank white WebView
when the Vite dev server is not running.

The CLI binary is defined in `crates/gyro-cli`:

```bash
cargo run -p gyro-cli -- doctor
cargo run -p gyro-cli -- setup
cargo run -p gyro-cli -- sessions
cargo run -p gyro-cli -- run "Inspect this repo"
cargo run -p gyro-cli -- run --profile codex --model gpt-5.5 "Inspect this repo"
cargo run -p gyro-cli -- run --worktree --profile codex "Try the safer refactor path"
cargo run -p gyro-cli -- resume
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
cargo run -p gyro-cli -- run --worktree --profile codex "Prototype the terminal restore flow"
cargo run -p gyro-cli -- app attach --worktree --branch gyro/restore-flow
```

Worktree mode requires the selected workspace to be inside a Git repository. Local mode remains the default.

## CLI Agent Launcher

The CLI surface is an agent launcher and control plane for local sessions:

- `gyro run` records a task, optional CLI profile, optional model hint, approval policy, workspace mode, branch, and resume command.
- `gyro resume [session-id]` continues the latest or selected session context and preserves recorded profile/model hints unless overridden.
- `gyro sessions` lists recent local sessions, with `--workspace` and `--json` for scripts.
- `gyro setup` checks storage, Git, Gyro.app IPC, configured CLI profiles, known agent commands such as Codex and Claude, and provider/Keychain readiness without editing third-party config.

Human output uses stable status labels: `ready`, `waiting`, `blocked`, `running`, `done`, and `failed`. Machine output is only emitted when `--json` is passed.

## Provider Setup

Gyro separates local app access from model-provider auth. Local device/session
state stays in Gyro's local store, while provider credentials stay with the
provider CLI, SDK, environment, or macOS Keychain.

The current provider surface tracks OpenAI, Anthropic, xAI, and Gemini. OpenAI
and Anthropic are CLI-oriented today; xAI and Gemini use environment-owned API
keys such as `XAI_API_KEY` and `GEMINI_API_KEY`. Provider health checks store
only readiness summaries and redact token-like output.

## Open Source

Gyro is licensed under Apache-2.0. Contributions use Developer Certificate of Origin signoff instead of a CLA.

See:

- [Architecture](docs/architecture.md)
- [Vision](docs/vision.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Roadmap](ROADMAP.md)
- [Release process](docs/release.md)
