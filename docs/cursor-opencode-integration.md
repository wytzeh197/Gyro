# Cursor, OpenCode, and Antigravity integration

Updated 1 November 2026. All three are supported providers in Gyro's local source. This status describes the implemented integration and the capability limits below; it is not a claim that every account or model was tested. Authenticated generation was explicitly excluded from this verification at the user's request. No release or installed-app update was performed.

## Connection and behavior

| Provider | Connection | Gyro behavior |
| --- | --- | --- |
| Cursor | Official `cursor-agent acp`; sign in with `cursor-agent login` | Streaming, images when supported by the selected model, session loading, Stop, tool approvals, and question/plan handoff to chat. |
| OpenCode | Official `opencode acp`; configure a model through `opencode auth login` and OpenCode's settings | Streaming, model selection, session loading, Stop, and tool approvals through a per-process Gyro agent. |
| Google Antigravity | Official `agy` CLI in `stream-json` print mode; run `agy` once to sign in with Google | Text streaming, model discovery, conversation resume, Stop, and native workspace tools with the restrictions below. |

Gyro uses `cursor-agent` rather than the ambiguous `agent` executable, which may belong to another provider. Installation uses the vendors' official installers; OpenCode also supports the official npm package. Antigravity's Connect flow now installs/launches `agy`, including migration of older environment-key settings. Gyro no longer offers a Gemini API key as Antigravity authentication; the CLI owns Google sign-in or Google ADC credentials. Antigravity chat is supported in the desktop app; the standalone `gyro` CLI still reports its Antigravity chat runner as unavailable.

## Permission and input behavior

**Cursor:** selected models fail explicitly if unavailable. Gyro reapplies `agent` or `plan` mode after opening or loading a session, so a previous planning turn cannot leave normal chat in planning mode. Cursor's blocking question and plan requests become Gyro chat questions. The native request receives a cancellation, the turn ends without further automatic work, and the user's next chat message resumes the conversation. Gyro never fabricates an answer or accepts a plan automatically. This is a chat handoff, not a native ACP `answered` response.

**OpenCode:** global permission configuration alone does not enforce Gyro approvals because agent-specific rules take precedence. Gyro creates a fresh primary agent in process-local `OPENCODE_CONFIG_CONTENT` and selects it after both new and loaded sessions. The agent requests approval for native tools, blocks edits in Plan mode, and disables native `task` delegation because those agents have separate permission rules. Gyro's MCP delegation remains available. User configuration files are not rewritten; provider/model configuration is preserved. Custom OpenCode agent prompts and native delegation are not used by this managed agent. Invalid inherited inline JSON fails explicitly. OpenCode extensions and native tools remain provider-owned; this adapter is not an OS security boundary.

**Antigravity:** the headless CLI has no per-tool approval callback. When either approval requirement is enabled, or the chat is in Plan/Council mode, Gyro launches read-only Plan mode and displays the reason. Approve for me uses sandboxed `accept-edits`; shell commands that still require native approval can be soft-denied by the CLI. Only Full access on a normal chat permits the CLI's permission bypass. Image attachments are not advertised because the documented stream input supports text only. Gyro MCP tools and plan quota windows are not advertised. A successful turn requires both exit success and a terminal success frame. Partial output remains visible on failure. Resume IDs survive cancellation where observed; usage is taken from this turn's steps rather than cumulative conversation totals.

## Verification

See [the dated verification report](reviews/provider-graduation-2026-11-01.md) for exact evidence and versions. Fixtures verify behavior and failure handling; protocol-only checks with real CLIs verify compatibility. Neither substitutes for authenticated model/tool execution or native UI acceptance.

Official sources:

- [Cursor ACP](https://cursor.com/docs/cli/acp)
- [Cursor's ACP distribution](https://github.com/agentclientprotocol/registry/blob/main/cursor/agent.json)
- [OpenCode ACP](https://opencode.ai/docs/acp/)
- [OpenCode permission precedence](https://opencode.ai/docs/permissions/)
- [OpenCode 1.19.5 agent permission implementation](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/agent/agent.ts)
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless/)
- [Antigravity configuration](https://antigravity.google/docs/cli/using)
