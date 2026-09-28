# AI provider backend upgrade plan

Date: 2026-09-27
Repository snapshot reviewed: `release/v0.1.0-alpha.49.7` at `70ad34c7`
Scope: subscription-backed CLI/ACP providers, local inference, and API-key providers

## Goal

Make provider turns start promptly, stream and call Gyro tools reliably, use fewer repeated input tokens, and recover safely from transient failures. Optimize for completed useful work per unit of latency and provider usage. Keep each provider's best native execution path and existing model quality, tool access, approval policy, and history continuity.

This plan was reviewed and implementation began on September 27. The original
source findings below describe the starting checkout. See the
[implementation report](../reviews/provider-backend-upgrade-2026-09-27.md) for
changes, verification, and remaining live-measurement gates. Unrelated local
appearance and browser changes were preserved.

## Implementation review and scope decisions

- Reuse existing timing, pooled connections, usage guards, bounded MCP queues,
  context compaction, and resume contracts. These already exist; extending them
  is preferable to building a replacement orchestration layer.
- Implement confirmed defects and bounded improvements now: all-round usage
  accounting, conservative Codex cumulative deltas, prompt cancellation during
  silent HTTP reads, a shared retry budget, strict optional API compatibility,
  schema validation, parallel independent workspace reads, selected-model-only
  Ollama metadata lookup, and broker/request telemetry.
- API image payloads already exist. Correct the documentation rather than
  scheduling them as missing functionality.
- Standalone Gyro CLI API chat remains a separate feature. This upgrade covers
  subscription CLI adapters inside desktop, desktop API chat, and desktop/CLI
  Ollama. The standalone CLI continues to reject unsupported API execution
  explicitly; its configuration support is documented separately.
- Provider-family scheduling changes, schema discovery experiments, process
  prewarming/reuse, and additional prompt compaction remain conditional on the
  live baseline. Do not change model, reasoning quality, or capability access
  speculatively. A cross-family live benchmark is still outstanding; local
  regression evidence alone does not close the phase performance exits.

## Current state from source

- **Three different execution contracts exist.** Subscription-backed providers use provider CLIs and ACP/app-server protocols (for example Codex, Claude Code, Kimi, Gemini, Grok, Cursor, and OpenCode). API-key chat runs through the desktop OpenAI-compatible HTTP/SSE adapter. Ollama uses a separate local HTTP/tool loop. The adapter choice is centralized in `run_provider_chat_once`, but the turn loops and transport behavior remain adapter-specific.
- **Useful reliability mechanisms already exist.** Provider turns have cancellation, bounded global concurrency, streamed activity, usage guards, retry handling, resume cursors, tool approvals, and per-mode tool capabilities. HTTP retries are bounded and limited to exchange errors; the outer retry path avoids rerunning a turn after output was published. ACP tools are exposed through Gyro's capability MCP bridge.
- **Tool calls are governed and bounded.** API and Ollama tools go through the same Gyro capability broker. Tool results and workspace/code navigation are paged or size-bounded. Models without native tools have a structured JSON bridge with validation and one malformed-action retry. A tool-round limit and local auto-compaction already exist for API/Ollama loops.
- **Usage data has gaps that matter to optimization.** `run_provider_chat_with_retry` records wall time and a per-call ledger row, but the fallback estimate in `provider_turn_tokens` counts only the user message and final answer. The September 16 context audit also flagged that Codex app-server `tokenUsage.last` may undercount a multi-request turn and that failed/cancelled turns can lack adapter-reported usage. Those findings must be checked against this checkout before they drive budget behavior.
- **Provider feature parity has an explicit gap.** `docs/api-key-providers.md` says the standalone `gyro` CLI can configure API providers but its chat loop is still subprocess-only; `crates/gyro-cli/src/main.rs` rejects the `OpenAiCompatibleApi` execution kind. Desktop API chat exists. Decide whether standalone CLI API chat is part of this upgrade's acceptance scope; it should not silently remain described as supported chat.
- **Current measured performance evidence is not provider evidence.** The Alpha 49.1 performance report measured local shell/UI smoke, explicitly not native provider latency. There is no current apples-to-apples result for first-token delay, tool round trips, successful-task token use, or provider recovery across these three execution families.

## Design rules

1. Measure completed tasks, not just raw tokens or request speed. A faster answer that causes more corrective turns is not an improvement.
2. Preserve native resume/session behavior when healthy. Fall back to Gyro's local transcript only when required, and never replay tool side effects as an automatic retry.
3. Prefer exact deduplication, cacheable stable prompt prefixes, and smaller relevant tool results over deleting tools, shortening history indiscriminately, or lowering model/reasoning quality.
4. Keep reported usage, locally measured timings, and estimates distinct. Unknown provider usage must remain unknown/estimated; do not let a weak estimate look like a hard spend ceiling.
5. Keep approvals, filesystem/workspace scoping, and capability policy in Gyro's broker for every provider path.
6. Do not force one transport abstraction onto subprocess/ACP, HTTP APIs, and local inference. Share turn contracts, diagnostics, and policy; retain transport-specific behavior where it is valuable.

## Work plan

### Phase 0 — Establish a trustworthy baseline

Add a small, privacy-safe diagnostic record per provider attempt and per tool call. Capture provider family, model, mode, resume/fresh status, attempt number, tool name/category, queue/wait time, connection or process startup time, time to first visible activity/token, tool execution duration, time to final response, cancellation/failure category, and reported versus estimated token counts. Do not store prompts, tool arguments, file contents, API keys, or raw provider streams in diagnostics.

Run the same bounded coding tasks across one subscription CLI, one API endpoint, and one local model. Include a no-tool answer, workspace search/read, a multi-tool edit/review, resume after an existing conversation, and a transient failure/cancel case. Record at least five trials per path and compare median/p95 plus task completion and correction rate. Separate cold local-model load from warm inference. Treat provider/model differences as cohorts; do not rank unlike models as if they were equivalent.

**Exit:** Each provider family has a baseline for first activity, first token, tool latency, completion latency, failure/retry rate, and tokens per completed task. No optimization claim is accepted from fixture or source checks alone.

### Phase 1 — Correct accounting and safe retry boundaries

1. Trace usage fields from each adapter into the ledger, including multi-round tool turns, resumed threads, retries, council/automation origins, and failed/cancelled attempts. Fix Codex cumulative-versus-last-request accounting with explicit turn/resume baselines and duplicate-notification handling if the current protocol semantics confirm the audit's concern.
2. Replace the two-string fallback estimate with an adapter-aware estimate over the actual assembled request where possible: stable instructions, conversation history, attachments, tool schemas, tool results, and response. Keep provider-hidden context explicitly outside the estimate. Mark incomplete/error-path estimates as lower bounds or unknown rather than reliable totals.
3. Record each HTTP exchange retry and CLI/ACP restart separately while preserving one user-visible turn. Apply retries only before any visible output or dispatched side effect. For ambiguous disconnects after a tool could have run, surface a resumable state instead of replaying the task automatically.
4. Normalize failure reasons into actionable classes (authentication/configuration, quota/rate limit, network, provider busy, malformed/incomplete tool output, timeout/stall, cancellation, local runtime/model load, tool failure). Honor provider retry guidance within a bounded deadline, add jitter where retries could synchronize, and keep long cooldowns visible instead of sleeping invisibly.

**Exit:** Reconcile ledger counts to provider-reported totals on supported test/live accounts where available; all other records state their estimate boundary. A failure-injection matrix proves no duplicate tool side effects and prompt cancellation through each transport.

### Phase 2 — Make tool calls cheaper and easier to complete

1. Instrument model-to-tool, broker queue, approval wait, tool execution, and tool-result-to-next-model-request separately. This shows whether the bottleneck is model reasoning, approval, local work, or transport.
2. Improve descriptions and schemas from observed failure data: remove ambiguous overlap, state when a tool is appropriate, make paging/continuation obvious, and return compact results with explicit truncation/next-page guidance. Keep existing authorization and result bounds.
3. Reduce repeated tool-schema and prompt cost only where a measured workload benefits. Compare the current full schema with a compact discovery/catalog path. Since discovery can add a model round, retain it only for providers/tasks where the total tokens and completion time improve without lowering tool success. Never silently hide a capability required by the active mode.
4. Allow independent, read-only calls in one provider batch to execute concurrently when ordering and resource scopes prove independence. Preserve approval per call and serialize writes, commands, browser actions, and calls with dependencies. Return results in stable call order.
5. Improve MCP lifecycle/reuse for CLI/ACP sessions only if process startup is present in the baseline; preserve per-session capability binding and cancellation. Keep tool execution local and avoid extra provider round trips for data Gyro already has.

**Exit:** Representative tasks show fewer tool-call validation/recovery rounds or lower tool-result/schema tokens, while tool success, approval behavior, and task completion remain level or improve.

### Phase 3 — Reduce repeated context and provider wait

1. Consolidate exact shared prompt sections so fresh requests contain each instruction once. Keep changing per-turn guidance separate from stable prefixes. Use provider prompt caching only for providers that support it, after verifying cache-hit and billing fields in the ledger.
2. Retain local auto-compaction for API/Ollama as a measured tool-history compaction mechanism. Add safe, provider-specific compaction or checkpoint handoff where the CLI protocol supports it; never compact away the goal, user constraints, approval policy, unresolved work, or references needed to continue. Keep native resume preferred when it is healthy.
3. Reuse model/session state when the provider supports it. For local inference, measure model-load and queue time separately, avoid concurrent requests that overload one local runtime, and communicate warm/cold state. Do not automatically substitute a smaller model.
4. Replace the single coarse run cap with bounded provider-family/model admission and a fair queue, if baselines show that global concurrency blocks useful work or local runs contend. Interactive work should outrank unattended automation without starving already-running turns. Start from measured limits rather than increasing concurrency by default.
5. Tune connection, quiet-period, and total deadlines independently. Long model thinking or a long-running approved tool is not a stalled provider; actual lack of progress should be diagnosed and cancellable.

**Exit:** Lower median/p95 time-to-useful-activity and lower repeated-input tokens on long/tool-heavy tasks, with preserved resume correctness and no increase in local overload or automation starvation.

### Phase 4 — Provider-family parity and rollout

- **Subscription CLI/ACP:** Harden executable discovery, version/capability negotiation, login expiry detection, session reopen, stream parsing, and safe recovery. Avoid a generic retry policy that assumes all CLIs resume or have idempotent turns.
- **API-key endpoints:** Improve endpoint capability detection and first-request compatibility without repeated failed probes. Keep SSE streaming, usage accounting, error normalization, and native tool calls; report when fallback structured-tool mode costs extra rounds. Preserve existing image payload support; extend other payload types only as separate measured capability work.
- **Local models:** Report runtime reachability, model availability, cold load, context/tool support, and local capacity separately. Keep loopback and credential protections. Offer actionable setup guidance rather than repeatedly probing a missing runtime.
- **Gyro CLI parity decision:** Either explicitly scope OpenAI-compatible API chat into the standalone CLI after the shared request/usage/tool contracts are ready, or update docs and CLI configuration affordances so they clearly distinguish configurable providers from runnable providers. Do not market API execution in CLI until the same approval, usage, cancellation, and safety contracts exist.
- Roll out behind provider-family flags or staged builds. Compare against Phase 0 with the same tasks and provider/model cohorts. Roll back any optimization that worsens success/correction rates even if it saves tokens.

## Success measures

Primary:

- Successful task completion rate and correction/retry turns per task.
- Median and p95 time to first useful provider activity, first token, each tool result, and final answer.
- Measured or carefully bounded estimated input/output tokens per completed task, split into initial context, repeated context, tool schemas, and tool results where the provider exposes enough data.
- Tool-call success rate, malformed-call rate, approval wait, and duplicate side-effect count (target: zero).
- Failure recovery rate, safe retry rate, cancellation-to-stop latency, and stale-resume recovery rate.
- Local cold/warm model latency and memory/CPU pressure; API rate-limit frequency; CLI startup/auth failure rate.

Guardrails: no removed capabilities, no weaker approval or workspace isolation, no silent loss of history/goal, no unbounded retries, no tool replay after ambiguous completion, and no claim of token or cost savings from character counts alone.

## First implementation slice

Start with Phase 0 telemetry and Phase 1 accounting/retry correctness before optimizing prompts or raising concurrency. This sequence prevents the system from tuning itself against incomplete token counts or misidentifying provider latency as Gyro overhead. In the first review, decide the standalone CLI API-chat parity scope and select a small benchmark set of provider/model pairs that are available without assuming every user has the same accounts or local hardware.

## Source review

- Provider dispatch, guard, retries, and usage ledger: `apps/desktop/src-tauri/src/lib.rs` (`run_provider_chat_once`, `run_provider_chat_with_retry`, `provider_turn_tokens`, `record_provider_usage`).
- API tool loop and compaction: `apps/desktop/src-tauri/src/openai_compatible_runner.rs`.
- Local model tool loop and compaction: `apps/desktop/src-tauri/src/ollama_runner.rs`.
- CLI/ACP stream and resume contract: `crates/gyro-core/src/kimi_acp.rs`, `crates/gyro-core/src/provider_stream.rs`, and the ACP/app-server adapters in `lib.rs`.
- HTTP retry and stream bounds: `crates/gyro-core/src/provider_retry.rs`, `crates/gyro-core/src/openai_compatible.rs`.
- Tool capability contract and documented output bounds: `crates/gyro-core/src/provider_contract.rs`, `apps/desktop/src-tauri/src/provider_mcp.rs`, `docs/model-tools.md`.
- Usage policy and measurements: `crates/gyro-core/src/usage.rs`, `docs/usage-safety.md`, `docs/performance-contract.md`, `docs/performance/README.md`, `docs/performance/context-usage-audit.md`.
- Existing September 16 audit: useful findings, but its stated checkout was Alpha 48.5; revalidate each unresolved item on the implementation branch before coding.
