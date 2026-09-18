# API-key providers

Gyro can talk to any provider that speaks the OpenAI chat-completions wire
format, over HTTPS, using an API key you supply. Nothing else has to be
installed: there is no vendor CLI in the path.

Three providers ship as presets, and you can add your own endpoint.

| Provider | Base URL | Environment variable |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

These are **experimental** in this release.

## Add a key to a preset

1. Open **Settings → Providers**.
2. Under **Connect with an API key**, choose the provider.
3. Paste the key and press **Save key**.

The key is stored in the macOS Keychain, under the account
`provider:<provider-id>`. An environment variable of the same provider takes
priority over the stored key, so a shell that already exports
`DEEPSEEK_API_KEY` needs no further setup.

## Add your own endpoint

**Settings → Providers → Add custom provider** asks for a display name, a base
URL, an API key, and one or more model ids. **Fetch models** asks the endpoint
for its own list (`GET {base-url}/models`) and fills the model ids in for you.
The provider then behaves like any other: it appears in the provider list and in
the composer's model picker.

The base URL is used exactly as you type it, including any prefix such as `/v1`,
so enter the path the provider documents for its API.

The same thing from the CLI:

```sh
gyro config add-provider custom:my-gateway \
  --name "My Gateway" \
  --base-url https://gateway.example.com/v1 \
  --model llama-3.3-70b \
  --model qwen3-coder

gyro config set-provider-key custom:my-gateway --env MY_GATEWAY_KEY

gyro config remove-provider custom:my-gateway
```

`remove-provider` drops the config entry, clears the stored key, and clears the
provider as the default for new chats if it was selected.

## Local servers

LM Studio, vLLM, llama.cpp, and anything else bound to your machine work too.
Plain HTTP is accepted for loopback hosts only:

```sh
gyro config add-provider custom:lm-studio \
  --base-url http://localhost:1234/v1 \
  --model local-model
```

A loopback provider needs no API key at all. Every other host must use HTTPS.

## What the endpoint receives

- `POST {base-url}/chat/completions` with `"stream": true`, your messages, and
  the Gyro tools the current mode may grant.
- `Authorization: Bearer <key>`, when a key is set.
- `stream_options.include_usage`, so the response reports token counts. A
  gateway that rejects that field gets one automatic retry without it.

Streaming follows Server-Sent Events: `choices[].delta.content` becomes text in
the chat as it arrives, `choices[].delta.tool_calls` is accumulated across
frames, and the final `usage` block feeds the local usage ledger. A gateway that
ignores `stream: true` and answers with one JSON body is still understood.

Tool calls are executed by Gyro, not by the provider: every call goes through
the same capability broker and approval policy as a call from a local model, and
you approve it in the same way.

## Safety rules

- A non-loopback endpoint must be HTTPS, so the key is never sent in clear text.
- Credentials embedded in the URL are rejected; the key travels only in the
  `Authorization` header.
- Redirects are refused rather than followed, so a Bearer token cannot be walked
  to a host you did not configure.
- Provider errors are reported with the provider's own message, never with the
  key in them.

## Troubleshooting

Settings reports what the health check found:

- **No API key is stored** — add one, or export the provider's environment
  variable.
- **A key is stored, but the endpoint could not be reached** — the key was not
  rejected; the request never completed. Check the host, the path, and your
  network.
- **Answered but reported no models** — the base URL usually points above or
  below the API path. Most providers want the `/v1` suffix.
- **HTTP 401** — the provider rejected the key.

## Limitations in this release

- The standalone `gyro` CLI can configure these providers, but its chat loop
  still runs only the subprocess adapters. Use the desktop app to chat.
- Attachments are not sent: images would need OpenAI `image_url` content parts,
  which this runner does not build yet.
- There is no plan-window or quota API for these providers, so usage shows the
  spend Gyro observed rather than a remaining allowance.
