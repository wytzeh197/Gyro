# Token accounting implementation and coverage — 10 October 2026

Accounting now carries source, scope, coverage, known buckets and an uncertainty reason through receipts and turn totals. This is an implementation report, not certification of every provider, runtime or model. The approved accounting plan remains incomplete.

## Applied behavior

- Input includes cache reads/writes; output includes reasoning where the provider contract says so. Subsets are not added again. Missing buckets stay unknown, explicit zero stays zero, and incomplete/error/cancelled work retains observed consumption.
- Append-only receipt revisions replace a call's reading rather than add spend. Task attribution traverses exact session/turn identities, counts continuations and linked children once, and downgrades missing expected calls. Council containers need no fictional root call.
- Context occupancy and undifferenced session counters are excluded from consumption totals and budgets. Legacy measured rows lack verified consumption scope: their footer is unavailable, with unavailable numerics consistently excluded for one or many rows. Historical budget records retain their original numbers conservatively; history is not rewritten.
- Codex checks thread and turn identity, subtracts a verified pre-dispatch resume baseline, deduplicates cumulative updates, and retains earlier consumption on regressions. Claude keys requests by message ID, replaces provisional requests with results, preserves cache writes, and avoids adding anonymous/child mirrors.
- Ollama now sends its reconciled receipt to the collector; missing-side estimates, thinking provenance and coverage therefore survive ledger recording. Regressing metrics retain earlier counts and lose complete status. Gemini's outer incomplete flag also demotes its standard receipt.
- OpenRouter can recover a missing terminal SSE receipt through a bounded, cancellable metadata lookup on the exact official origin and generation ID. This replaces the request reading without another generation or billable collector entry. Lookup failure preserves the answer and existing partial/estimated usage.

Source: [usage/ledger](../../crates/gyro-core/src/usage.rs), [receipt attribution](../../crates/gyro-core/src/usage_receipts.rs), [ACP contracts](../../crates/gyro-core/src/acp_usage.rs), [HTTP adapter](../../crates/gyro-core/src/openai_compatible.rs), [Ollama](../../crates/gyro-core/src/ollama.rs), [native accounting](../../apps/desktop/src-tauri/src/native_accounting.rs), [desktop integration](../../apps/desktop/src-tauri/src/provider_accounting.rs).

## Adapter coverage matrix

“Complete-capable” describes valid fixture/contract inputs; it does not certify a live account.

| Provider / adapter | Catalog entries | Accounting boundary | Remaining gate |
| --- | ---: | --- | --- |
| OpenAI / Codex app-server | 10 | Complete-capable turn delta; missing baseline/reset stays uncertain | Exact CLI version/model and fresh/resumed counter reconciliation |
| Anthropic / Claude stream JSON | 9 | Main-loop requests/results; whole-tree evidence guard exists | Production never supplies `set_tree_evidence`; tree billing remains unverified |
| Kimi / ACP | 1 | Unavailable: unsupported runtime | Reviewed Wire bridge with authenticated session/turn binding; preserve approvals, filesystem/MCP and resume parity |
| xAI / Grok ACP | 4 | Inclusive prompt usage; incomplete/error spend retained | Exact runtime/model and multi-request turn scope reconciliation |
| Gemini / ACP | 1 delegated default | Standard usage can include separate thoughts; quota/per-model alternatives remain partial | Quota drops cache/thought detail; certify actual routed model and version |
| Cursor / ACP | 1 delegated default | Unavailable: unverified semantics | Establish whether reported fields mean request, turn, session or occupancy |
| OpenCode / ACP | 1 delegated default | Partial last-step request; cache and thoughts normalized once | Earlier model steps/retries need identified receipts; occupancy cannot fill the gap |
| DeepSeek / compatible HTTP | 2 | Complete-capable final request receipt; hit/miss cache input normalized | Exact endpoint/model live reconciliation |
| Mistral / compatible HTTP | 4 | Complete-capable final request receipt; absent details unknown | Exact endpoint/alias resolution and live reconciliation |
| OpenRouter / compatible HTTP | 11 | SSE plus bounded generation-receipt recovery | Routed model/provider and native tokenizer counts must reconcile live |
| Ollama / local HTTP | 0 static | Request metrics summed across rounds; thinking breakdown estimated | Exact runtime/model digest and completion/cancellation metrics |

HTTP and Ollama snapshots retain observed high-water counts and flag regressions as uncertain. Missing halves that use character estimates mark the whole reading estimated, and estimates cannot erase already reported cache/reasoning lower bounds. Cache-only and reasoning-only API observations retain their provenance.

## Provider/model inventory

Sources: [bundled catalog](../../packages/ui/src/provider-catalog.ts) and local [overlay](../../site/model-catalog.json), revision `2026-10-10.1`. The base has 40 entries; six overlay entries add four IDs and update two existing IDs. Their merged local inventory is **11 providers, 44 entries: 41 concrete provider/model pairs and three delegated defaults**. This is catalog enumeration, not authenticated model availability or deployed-overlay evidence.

- **OpenAI (10):** `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
- **Anthropic (9):** `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, `claude-haiku-4-5`.
- **Kimi (1):** `k3`.
- **xAI (4):** `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`.
- **Gemini (1 default):** `gemini-default`.
- **Cursor (1 default):** `cursor-default`.
- **OpenCode (1 default):** `opencode-default`.
- **DeepSeek (2):** `deepseek-flash`, `deepseek-v4-pro`.
- **Mistral (4):** `mistral-medium-latest`, `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`.
- **OpenRouter (11):** `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `openai/gpt-6-astra`, `google/gemini-3.8-flash`, `x-ai/grok-4.7`, `x-ai/grok-4.6`, `deepseek/deepseek-v4.1-flash`, `moonshotai/kimi-k3`, `z-ai/glm-5.3`, `qwen/qwen3.8-max-0902`, `meta-llama/llama-3.3-70b-instruct`.
- **Ollama (0 static):** installed models are discovered at runtime. Custom endpoints and user-entered IDs are an open-ended inventory.

## Certification gate

Certification applies only to an evidenced tuple of provider/endpoint, runtime version, actual resolved model (or local digest), protocol/receipt schema, scope and baseline method.

1. Capture the runtime's returned identity and model, not just the requested alias or successful handshake. Prove inclusive/disjoint cache and reasoning semantics and whether a counter covers one request, a turn, a session or the whole task.
2. For cumulative counters, bind a complete pre-dispatch baseline to the exact resumed session/thread; prove zero for a genuinely fresh counter. Missing baselines, resets, conflicting identities or regressions cannot be promoted to complete.
3. Reconcile numeric provider receipts, ledger rows and displayed task totals on authorized live fresh/resumed, multi-tool, cache-write/read, retry, interruption and child-work cases. Duplicate snapshots, corrections and child links must not add another bill.
4. Record bounded numeric evidence, observation time and the exact tested tuple. Retest changed versions/models or scope contracts; certification does not transfer to every catalog entry.

Claude's implemented tree guard specifically requires schema 1, an exact observed runtime version and session ID, declared turn/session scope, and a measured session baseline for cumulative scope. No production caller currently supplies that evidence. Kimi and Cursor need their missing contracts/bridges before this live gate can close.

## Validation status

Inspected fixtures assert explicit zero versus missing usage, cache/reasoning subsets, repeated frames, failed/cancelled consumption, bounded receipt drain/recovery, Codex identity/baselines, Claude message/tree deduplication, receipt replacement/reopen, exact child attribution, missing calls, scope exclusion, legacy policy, Ollama collector equality/regressions and Gemini incomplete flags.

The full offline run passed 543 core tests (serial), 542 desktop tests (five pre-existing live/GUI tests ignored), and 64 CLI tests (40 unit and 24 integration). After the final API/Ollama refinements, 48 compatible-API tests and 25 Ollama tests passed. The token/ledger UI checks and desktop TypeScript checks also passed again. Shared UI typecheck passed. The final collector change passed all eight observation tests and desktop Cargo check; remaining native tree-evidence warnings reflect the documented production integration gap.

The standalone actual `ChatSurface` fixture verified complete, partial, estimated, unavailable, reported-zero, cache/reasoning and cancelled-without-answer states. A late receipt changed the rendered footer from zero to 2,000. The fixture uses labelled synthetic data, not native IPC. No visual certification of the full native app is implied.

A bounded fresh CLI ACP probe with Grok Build 1.0.50, protocol 1 and observed model `grok-4.7` returned the expected response. Provider receipt, persisted task event and ledger agree on **17,672 tokens = 17,632 input + 40 output**, including 1,664 cached input and 36 reasoning output already inside the totals. It reports one model call and `usageIsIncomplete: false`. See [numeric evidence](token-accounting-live-2026-10-10.json). This establishes that fresh, one-call tuple; resumed, multi-tool, interruption and other-model live reconciliation remain unverified.

One authorized Grok generation probe used the existing account in a disposable store. No CLI installation, model download, server startup or publication was performed. Standalone CLI ACP and Ollama now persist collected receipts on success/error; standalone Codex/Claude do not yet share the desktop native accounting collector and remain outside exact CLI certification. Earlier [provider verification](provider-verification-2026-10-10.md) establishes some generation/resume behavior and records unavailable accounts/runtimes; those results do not certify this accounting change or every model. The [plan's live reconciliation exit](../design/2026-09-27-provider-backend-upgrade-plan.md) remains open.
