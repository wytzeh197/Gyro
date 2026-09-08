# Terminal launch commands

Verified 8 September 2026. These are interactive entry points, not installation commands.

| CLI | Command | Official reference |
| --- | --- | --- |
| Claude Code | `claude` | [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Codex | `codex` | [Getting started](https://help.openai.com/en/articles/11096431) |
| Kimi Code | `kimi` | [Command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command) |
| Grok Build | `grok` | [CLI reference](https://docs.x.ai/build/cli/reference) |
| Gemini CLI | `gemini` | [Installation and execution](https://geminicli.com/docs/get-started/installation/) |
| Ollama | `ollama run <model>` | [CLI reference](https://docs.ollama.com/cli) |
| Cursor | `cursor-agent` | [CLI overview](https://docs.cursor.com/en/cli/overview) |
| OpenCode | `opencode` | [CLI reference](https://opencode.ai/docs/cli/) |

The terminal launcher preserves saved custom executable paths and arguments. Missing built-in profiles are supplied by the shared terminal launch catalog. The legacy `ollama-api` marker becomes `ollama run` only when preparing a terminal launch; Ollama chat continues to use its API.

Provider launches require an enabled, connected provider in Gyro. Recorded sign-in rejection or a checked disconnected/failed health state also blocks launching. The start screen disables these rows with “Not connected”; the shared launch boundary checks again before creating a pane. Shells need no provider connection. Ollama additionally needs a selected model, otherwise it shows “Choose a model”.

This gate reflects Gyro's known connection state; it does not install CLI binaries or guarantee that a previously connected login has not expired since its last check.
