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

One `agy` process per turn, in the CLI's headless ("print") mode:

```
agy -p <prompt> --output-format stream-json [--model <id>] [--effort <level>]
    [--sandbox --mode accept-edits | --dangerously-skip-permissions]
    [--conversation <id>]
```

The stream is line-delimited JSON (`crates/gyro-core/src/antigravity_cli.rs`
owns the contract):

```
{"event":"step_update","step_update":{"conversation_id":"…","step_type":"agent_response","text_delta":"Hel"}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"Hello\n",
 "usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,"cache_read_tokens":…,"total_tokens":…}}}
```

`step_update` frames drive the streaming text; the `result` frame is the answer
backstop, the failure detail, the token counts, and the `conversation_id` the
next turn resumes with `--conversation`. A stopped or failed turn still records
that cursor, so the user's next message continues the same Antigravity thread.

`--effort` is forwarded only for values the CLI documents (`low`, `medium`,
`high`, `xhigh`, `max`); an unknown level is dropped rather than sent, because a
rejected flag costs the whole turn.

## Approvals

A headless `agy` run has no channel for a per-call approval dialog, so the
provider descriptor reports `supports_approvals: false` and Gyro maps its own
posture onto the CLI's launch flags instead:

| Gyro posture | `agy` flags |
| --- | --- |
| Full access (no command or edit approval required) | `--dangerously-skip-permissions` |
| Plan mode / approval-gated | `--sandbox --mode accept-edits` |

Every non-full-access run keeps Google's sandbox on, which is the containment
the CLI offers without a dialog. Users who need a click-through approval should
choose a provider whose CLI exposes a permission channel (Claude Code, Codex).

## Models and usage

The model menu is the CLI's own inventory (`agy models`), not a hardcoded list,
so an enterprise or plan-specific catalog appears without a Gyro release. The
`antigravity-default` model id means "send no `--model`" and keeps the CLI's
current default. Token counts come from the `result` frame of each run; plan
windows (`supports_usage`) are not scraped yet.

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
