# Google agent backends

Checked on 2026-10-14.

Google Antigravity is Gyro's Google provider. It uses Google's official
`agy_acp_server.par`, ACP server version 1.3.0. Gemini CLI has been removed from
the provider catalog and built-in terminal profiles. Older configs drop its
provider entry and profile; an already connected Antigravity provider can take
over a Gemini selection. Gemini CLI OAuth sign-in is not transferred, so
Antigravity must be connected separately. Historical Gemini chats retain their
original identity.
It shares the existing governed ACP transport for streaming, MCP tools,
permissions, client filesystem access, cancellation, and session continuity.
The Antigravity provider remains experimental until authenticated live tool,
approval, and resume checks have been completed.

## Connection and models

This first integration uses a Gemini API key: configure it on the Google
Antigravity provider in Gyro Settings, or supply `GEMINI_API_KEY` in the local
environment. Stored keys use a separate Antigravity Keychain account. Unrelated
provider credentials are removed from agent processes.

The server advertises Google personal/business OAuth and Agent Platform auth,
but those sign-in flows are not wired into this version of Gyro. The Antigravity
CLI `agy`, Python SDK, and official ACP server are different launch surfaces;
installing or logging into one must not be assumed to configure the others.

After a provider connects, Gyro opens a metadata-only ACP session to discover
its model IDs and labels. The model menu's refresh action repeats discovery.
Both the legacy `models.availableModels` inventory and modern model
`configOptions` are supported. Discovery makes no inference request and rejects
all incoming client tool requests.

Discovered models have no invented context limit or reasoning-effort ramp.
Runtime-reported context remains authoritative. Selecting a specific Google
model must succeed before Gyro sends the prompt; a failed switch cannot
silently continue with the agent's default.

Gemini 4 Argon is in Google's restricted Fairwind rollout. It is not added as a
public model. The provider's returned inventory determines the available
choices; metadata alone cannot establish an account's entitlement.

## Runtime setup

The macOS distribution can be installed under
`~/.local/share/gyro/providers/antigravity/1.3.0/`; Gyro searches that directory,
as well as its usual CLI PATH. The real ACP handshake has been verified using
a temporary copy of the official server. Install the runtime separately; it is
not bundled into a desktop release by these changes.

Use the Google-published platform archive listed in the ACP Registry. Preserve
the distribution's companion files alongside `agy_acp_server.par`.

## Verification

`node --experimental-strip-types scripts/check-google-models.mjs` checks picker
merging, stale-selection fallback, custom model preservation, provider
isolation, and unknown context/effort metadata. Core ACP tests cover both
inventory shapes, metadata-only discovery, and rejection of unavailable
models before a prompt. The production composer fixture includes explicitly
labeled Antigravity discovery data without making provider requests.

The targeted model catalog, capability manifest, Google inventory merging,
core ACP, config, credentials, desktop model tests, and workspace typecheck
passed. `pnpm test:google-models-browser` verifies the actual composer fixture's
model menu, selection, unknown context, and absent reasoning-effort control in
a background browser. Start the desktop Vite server on port 1437 first, or set
`GYRO_TEST_ORIGIN` to its origin.

The real server's initialization verified image support, load/resume support,
and authentication method IDs. No authenticated conversation was tested:
a Gemini API key is not configured on this Mac.

## Sources

- [Official Antigravity ACP distribution](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/)
- [Antigravity CLI headless interface](https://antigravity.google/docs/cli/headless/)
- [Antigravity SDK](https://antigravity.google/docs/sdk/overview)
- [Gemini 4 Argon rollout](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/)
