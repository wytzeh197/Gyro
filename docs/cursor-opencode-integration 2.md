# Cursor and OpenCode integration status

Local implementation; not released or verified with real provider accounts.

Both providers now use the shared ACP runner in desktop and CLI, with disabled-by-default provider settings, streaming, session resume routing, cancellation, and permission callbacks. The selected model comes from the provider CLI configuration. Images and usage reporting are not advertised.

## Setup for live verification

- Cursor: install Cursor CLI, ensure `cursor-agent` is on PATH, then run `cursor-agent login`. Gyro deliberately avoids the ambiguous `agent` executable, which belongs to Grok on this development machine.
- OpenCode: install `opencode`, run `opencode auth login`, and configure its default model. A successful ACP handshake alone does not verify model credentials.
- Enable the chosen provider in Gyro settings and select its default model.

Official references: [Cursor ACP](https://cursor.com/docs/cli/acp), [OpenCode ACP](https://opencode.ai/docs/acp/), [OpenCode permissions](https://opencode.ai/docs/permissions/).

## Validation and remaining limits

Protocol fixtures verify streamed output, denied tool requests, and cancellation of Cursor question/plan requests. Routing tests cover both providers. These fixtures are not evidence of real provider behavior.

Before removing the website's Soon labels, verify each installed CLI with a real model: send and stream a prompt, cancel a running turn, resume a session, allow and deny a file edit and shell command, and confirm denied operations leave no effects.

OpenCode receives an explicit ask-first permission environment. Its agent-specific configuration can override global permissions; approval enforcement with customized agents remains unresolved and must be validated or constrained before production support is claimed. Do not treat this adapter as a security boundary.

Cursor's interactive question and plan extensions are cancelled with a visible activity message; rich in-chat replies to these extensions are not yet implemented.
