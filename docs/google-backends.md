# Google agent backends

Checked on 2026-10-18 against `agy` 1.4.2 (installed here from Google's
installer) and Google's published CLI documentation.

Google Antigravity is Gyro's Google provider, and it now runs through Google's
first-party **Antigravity CLI (`agy`)** instead of the separately provisioned
ACP bridge (`agy_acp_server.par`). Gemini CLI remains removed from the provider
catalog and built-in terminal profiles: older configs drop its provider entry
and profile, an already connected Antigravity provider can take over a Gemini
selection, and historical Gemini chats retain their original identity.

## Install and sign-in

Google ships one installer per platform. On macOS, Linux, and Googlebooks:

```
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The installer writes `agy` to `~/.local/bin/agy` (a path Gyro's provider PATH
already includes) and keeps its binary set under `~/.antigravity/bin`. The CLI's
settings and signed-in account live in `~/.gemini/antigravity-cli/settings.json`.

Sign-in is a browser OAuth flow started by running `agy` with no arguments.
Credentials are shared across Antigravity surfaces on the same machine, so one
CLI sign-in also covers the App, the IDE extensions, and the SDK. Gyro does not
run that flow itself: it detects the real state and tells the user to run `agy`
once. `agy models` is the probe — it lists the plan's models when signed in and
prints `Please sign in to view available models` when not, so a single call
answers "installed?" and "signed in?" together.

## Execution

One `agy` process per turn, as Google's official ACP server, with no extra flags:

```
agy acp
```

Gyro does not wrap `agy -p` or pass `--sandbox`, `--mode`, or
`--dangerously-skip-permissions`. The prompt goes over the ACP session. Only
Gemini model ids are sent. Claude, GPT, orchestrator modes, and the
"Automatic" default are refused before the process starts.

## Approvals

The provider descriptor still reports `supports_approvals: false`. Permission
requests that `agy acp` sends are answered by the shared ACP runner.

## Models and usage

The model menu keeps Gemini ids from `agy models`. Non-Gemini ids are dropped.
Plan windows (`supports_usage`) are not scraped.

## Verification

- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` — exit 0.
- `cargo test -p gyro-core` — 727 passed. The 4 failures are the pre-existing
  Ollama/OpenAI-compatible stream-cap tests, untouched by this change.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — 725 passed,
  0 failed.
- `crates/gyro-core/src/antigravity_cli.rs` unit tests parse the documented
  frames: deltas, tool steps ignored, result text, conversation id, usage,
  failure status, sign-in marker, and argument vectors for both postures.
- Live CLI checks on this Mac: `agy --version` → 1.4.2; `agy models` →
  `Error: Please sign in to view available models`, which is exactly the state
  Gyro reports as "installed, not signed in".

Not verified: an authenticated turn end to end, because this Mac has no Google
account signed in to the CLI. `agy` sign-in is a user action; until it happens
the provider correctly reports itself as not connected.

## Sources

- [Get started (CLI install)](https://antigravity.google/docs/getting-started)
- [Authenticate](https://antigravity.google/docs/install)
- [Headless mode](https://antigravity.google/docs/cli/headless)
- [CLI settings](https://antigravity.google/docs/cli/using)
- [CLI reference](https://antigravity.google/docs/cli/reference)
- [Antigravity SDK](https://antigravity.google/docs/sdk/overview)
- [Gemini 4 Argon rollout](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/)
