# Model context audit — 10 October 2026

Reviewed all 11 bundled providers and the local remote-catalog overlay: 41
concrete model IDs and three delegated CLI defaults. Ollama discovers installed
models instead of shipping model IDs. Official documentation establishes model
specs; it does not establish an individual account's entitlement or a running
CLI's allocation. No generation requests were made for this audit.

## Corrections

| Integration / model | Previous baseline | Corrected baseline | Evidence |
| --- | ---: | ---: | --- |
| Codex / `gpt-6.1-sol` | 272,000 | 500,000 | Installed Codex 0.162.1 model catalog, fetched 10 October 2026; its API specification is separately 1,050,000 |
| Grok / `grok-4.3` | 131,072 | 1,000,000 | [Official model specification](https://docs.x.ai/developers/models/grok-4.3) |
| Gemini CLI default | 1,000,000 | 1,048,576 | Installed Gemini CLI 0.63.0 `tokenLimits.ts` implementation; [Google model specification](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| OpenRouter / `z-ai/glm-5.3` | 1,310,720 | 1,048,576 | [Official public model catalog](https://openrouter.ai/api/v1/models), including `top_provider.context_length` |

The Sol correction is included in both the bundled catalog and the local
`site/model-catalog.json` overlay (revision `2026-10-10.1`). The other corrections
are bundled changes. Nothing was deployed or published.

Context reports for the selected provider/model now take precedence over static
catalog values. Opening the picker on that same model preserves the runtime
window; browsing a different model uses its own catalog value. This matters for
Codex configuration overrides and Ollama's smaller per-request allocation.
Unknown Cursor, OpenCode, and custom-endpoint windows display **Window unknown**
instead of assuming 128,000 tokens or showing a percentage of a guessed limit.

The native runner previously had no bundled windows for DeepSeek, Mistral, or
OpenRouter. All 17 curated API entries now resolve a window for usage tracking,
context checkpoints, and automatic compaction. Unknown API model IDs remain
unknown rather than inheriting another model's limit.

## OpenAI: API specifications and Codex defaults

Gyro uses Codex for this provider. The API maximum must not replace the CLI's
default allocation. The local Codex catalog reports `context_window` and
`max_context_window` separately; GPT-6.1 Sol defaults to 500,000, the listed
GPT-6 and GPT-5.6 models to 272,000. Their local maximum is 872,000. Runtime
reports, including effective windows and configuration overrides, remain
authoritative. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents configurable context windows.

| Model and official API documentation | API context | Gyro Codex baseline |
| --- | ---: | ---: |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | 1,050,000 | 500,000 |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | 1,050,000 | 272,000 |
| [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | 1,050,000 | 272,000 |
| [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | 1,050,000 | 272,000 |
| [gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | 1,050,000 | 272,000 |
| [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | 1,050,000 | 272,000 |
| [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 1,050,000 | 272,000 |
| [gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) | 1,050,000 | 272,000 |
| [gpt-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) | 1,050,000 | 272,000 |
| [gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) | 400,000 | 400,000 |

GPT-5.4 and GPT-5.4 mini are absent from the current local Codex model cache;
their existing baselines were retained, with their API specs checked. This is
not a live account-access certification for those models.

## Anthropic, Kimi, xAI, DeepSeek, and Mistral

| Provider | Every concrete model ID in Gyro | Documented context / baseline assessment |
| --- | --- | --- |
| Anthropic | `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5` | 1,000,000 each; unchanged. [Official context-window table](https://platform.claude.com/docs/en/build-with-claude/context-windows) |
| Anthropic | `claude-haiku-4-5` | 200,000; unchanged. [Official context-window table](https://platform.claude.com/docs/en/build-with-claude/context-windows) |
| Kimi Code | `k3` | Up to 1M on Allegretto / Pro and above; Moderato / Plus supports 256K. Retained 262,144 as the conservative offline baseline and corrected the misleading claim that all Kimi models are capped there. The [official model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html) and [error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html) explicitly describe the entitlement difference. |
| xAI | `grok-4.7`, `grok-4.6`, `grok-4.5` | 500,000 each; unchanged. Official [4.7 catalog](https://docs.x.ai/developers/models), [4.6 specification](https://docs.x.ai/developers/models/grok-4.6), [4.5 specification](https://docs.x.ai/developers/models/grok-4.5) |
| xAI | `grok-4.3` | 1,000,000; corrected. [Official specification](https://docs.x.ai/developers/models/grok-4.3) |
| DeepSeek | `deepseek-flash`, `deepseek-v4-pro` | Documentation publishes 1M each; retained the existing 1,000,000 baseline. These resolve to V4.1 Flash and V4 Pro respectively. [Official model details](https://api-docs.deepseek.com/quick_start/pricing/) |
| Mistral | `mistral-medium-latest`, `mistral-large-latest`, `mistral-small-latest` | Documentation publishes 256K each for Medium 3.5, Large 3, Small 4; retained existing 256,000 baselines. [Official limitations](https://docs.mistral.ai/resources/known-limitations) and [alias mapping](https://docs.mistral.ai/vibe/code/cli/configuration) |
| Mistral | `codestral-latest` | Documentation publishes 128K; retained existing 128,000 baseline. [Official limitations](https://docs.mistral.ai/resources/known-limitations) |

Kimi's current ACP adapter does not capture a provisioned context window, so
the actual account-specific K3 limit remains unverified. The conservative
baseline avoids claiming a 1M entitlement for a Plus account, but underreports
the maximum for an eligible Pro account until the adapter receives that fact.
The source publishes shorthand 1M/256K rather than an exact integer for each
plan. Likewise, DeepSeek and Mistral's documentation uses shorthand units;
their retained decimal baselines are not proof of a binary-token ceiling.

## OpenRouter: all 11 curated entries

Compared exact IDs and both `context_length` and
`top_provider.context_length` in the [official public API](https://openrouter.ai/api/v1/models).
The two fields agreed for every listed entry. The routing provider's limit is
the relevant specification for this integration.

| Exact model ID | Context tokens | Result |
| --- | ---: | --- |
| `anthropic/claude-sonnet-5` | 1,000,000 | Matches |
| `anthropic/claude-opus-5` | 1,000,000 | Matches |
| `openai/gpt-6-astra` | 1,050,000 | Matches |
| `google/gemini-3.8-flash` | 1,048,576 | Matches |
| `x-ai/grok-4.7` | 500,000 | Matches |
| `x-ai/grok-4.6` | 500,000 | Matches |
| `deepseek/deepseek-v4.1-flash` | 1,048,576 | Matches |
| `moonshotai/kimi-k3` | 1,048,576 | Matches |
| `z-ai/glm-5.3` | 1,048,576 | Corrected from 1,310,720 |
| `qwen/qwen3.8-max-0902` | 1,000,000 | Matches |
| `meta-llama/llama-3.3-70b-instruct` | 131,072 | Matches |

## Delegated defaults and local models

- `gemini-default` delegates model selection to Gemini CLI. Its installed
  token-limit implementation uses 1,048,576 for normal Gemini routing;
  Gemma 4 local routing uses 256,000. A single static default cannot certify
  arbitrary user routing. [Official CLI model selection](https://geminicli.com/docs/cli/model/)
  and [routing precedence](https://geminicli.com/docs/cli/model-routing/) explain
  how configuration chooses the actual model.
- `cursor-default` delegates to Cursor. Its [official model table](https://cursor.com/docs/models-and-pricing)
  contains different default and maximum windows. No universal limit was added.
- `opencode-default` delegates to OpenCode. Its [official model documentation](https://opencode.ai/docs/models/)
  describes provider/model selection and custom input/output/context limits.
  No universal limit was added.
- Ollama discovers each installed model's maximum from `/api/show` and sends
  an explicitly chosen `num_ctx` allocation. The meter now respects that
  runtime allocation instead of replacing it with the larger model maximum.
  [Official context-length documentation](https://docs.ollama.com/context-length)
  distinguishes runtime context settings from model capacity. No models were
  downloaded and no service was started for this audit.
- User-entered custom model IDs without an advertised window remain unknown.
  Account-specific routing and unlisted models require runtime metadata;
  public documentation alone cannot establish those allocations.

## Validation

Composer regressions cover matching runtime precedence, same-model picker
behavior, provider/model switches, Kimi entitlement-size reports, smaller local
allocations, corrected defaults, unknown windows, and live context streaming.
Catalog validation verifies the Sol overlay reaches the picker once. Native
tests cover all 17 API windows, compaction thresholds, and runtime overrides.
Type checks cover the shared UI and desktop app. Test results are recorded in
the companion JSON snapshot.
