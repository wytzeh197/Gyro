# Gyro model efficiency roadmap

Date: 2026-11-15. Status: started; measurement preparation implemented, live
evaluation pending. Source checkout: `6ba9a7c0`.

## Decision

Optimize **total cost per independently verified task**, while increasing the
rate of correct completion with the user's chosen model and reasoning effort.
Gyro controls the work surrounding inference, not a provider's base token price.
The opportunity is to give models useful evidence, avoid unnecessary requests,
reuse context where economical, and catch mistakes before they become rework.

Build on the existing efficiency system. First measure its independent policies;
do not add another orchestration layer or enable every experiment together.
Support every adapter through shared contracts, but qualify results separately
by provider path and model. One policy cannot be promised to improve every model.

## Evidence verified in this pass

| Finding | Current source | Implication |
| --- | --- | --- |
| Owned API requests retire older large tool results during request preparation. Stable-prefix retention is opt-in and excludes JSON compatibility mode. | `crates/gyro-core/src/efficiency/context.rs`, `crates/gyro-core/src/provider_runtime/runners/openai_compatible.rs` | Fewer request bytes may sacrifice reusable cached context. Compare total cost, not payload size alone. |
| The retention experiment checkpoints after eight preparations or 64 KiB of growth, and allows earlier compaction/recovery. | `crates/gyro-core/src/efficiency/prefix_retention.rs` | A concrete first experiment already exists; those thresholds are candidates, not proven optima. |
| Shared tool-result handling retains an 8 KiB fresh-read window by default and avoids re-spilling explicitly paged spill reads. | `crates/gyro-core/src/efficiency/mod.rs`, `crates/gyro-core/src/provider_runtime/tool_batch.rs` | Reuse this foundation. Blindly reducing read size can add recovery calls and hide necessary source. |
| Conditional workspace reads inspect current content and omit the body only when the caller supplies a matching prior hash. | `apps/desktop/src-tauri/src/workspace_capability_read.rs` | Promote correct use of existing evidence reuse; a hash is not permission to omit a previously unseen range. |
| Checkpoints, repository signals and repeated-work detection exist, but their activation is gated. `experimental` and standalone repeated-work detection default to false. | `crates/gyro-core/src/efficiency/mod.rs`, `apps/desktop/src-tauri/src/efficiency.rs` | Existing code does not mean every feature is active. Test and graduate capabilities independently. |
| Shared prompts distinguish fresh/resumed turns and isolate internal requests. | `apps/desktop/src-tauri/src/providers/prompt.rs` | Preserve these reductions; do not rebuild a universal giant prompt. |
| A paired runner, complete-cohort report gates and frozen repository tasks already exist. | `scripts/benchmark-efficiency.mjs`, `scripts/efficiency-report.mjs`, `scripts/fixtures/efficiency-repo/README.md` | The next useful deliverable is comparative evidence, not another benchmark framework. |

Offline validation run during this audit:

- `node scripts/check-efficiency-repo-pilot.mjs`: three frozen tasks validated,
  25 reference checks passed, nine faulty repairs rejected.
- `node scripts/check-efficiency-pilot.mjs`: 40 independent pilot verifiers and
  report gates passed.
- These are fixture/harness checks. They do not establish model quality, live
  savings, cache behavior, or installed-app acceptance. No generations ran.
- The frozen repository pack contains seeded regressions in extracted modules;
  it is not a representative sample of real production work.

## Ordered work

### 1. Establish a trustworthy baseline

Use the existing harness and receipt ledger. Record total task input/output,
cache reads/writes where available, generation attempts, tool failures,
recovery reads, elapsed time, independent correctness, and scope violations.
Include failed attempts and supporting calls in cost. Keep unobserved values
unknown; subscription allowances are not dollar-denominated token balances.

Separate task families: small edits, unfamiliar bugs, multi-file features,
long-session recovery, and read-only investigation. Add held-out cases from
actual Gyro work before making a production-wide claim. Include a case with a
mid-task correction, an externally changed file, a tool failure, and forced
compaction. Keep verifiers independent of the agent's final success claim.

**Exit:** reproducible matched runs, complete usage coverage on the selected API
route, and a baseline failure breakdown. Missing accounting blocks a monetary
claim; it does not turn into zero cost.

### 2. Test context reuse first

Compare baseline against `stable-api-prefix`, holding the model, effort, tools,
task snapshot and permissions constant. Inspect actual cache reads/writes and
uncached input, alongside correctness and recovery calls. Keep existing context
window guards. Retention must remain bounded.

This is the first cost experiment because its implementation already exists and
its hypothesis is specific: retaining earlier messages may avoid paying to
process the same prefix again. It is not a predicted percentage saving.
OpenAI explicitly recommends preserving history and tool definitions for cache
reuse; its documentation also distinguishes cache behavior by model family.
[Source](https://developers.openai.com/api/docs/guides/prompt-caching).

**Exit:** pass the existing paired gate on the tested route. If it loses, inspect
context growth and cache receipts before changing thresholds. Do not enable it
for every endpoint based on one model's result.

### 3. Improve useful evidence and tool reliability

Use baseline failures to choose the next change. Priorities are wrong-path
retries, repeated discovery, unnecessary rereads, misleading truncation, and
confusing error recovery. Improve the responsible tool contract or result at the
shared broker whenever possible, so API and MCP clients benefit together.

Evaluate repository outlines and targeted reads against ordinary search. Return
explicit paths, relevant symbols, test locations, current file identity and
recoverable source references. Preserve unsaved-buffer identity and workspace
scope. Expand context when the task needs it; do not force every read into a tiny
window. Compare 8 KiB against an alternate size only if traces show fragmentation
or excessive unused text. Batch independent reads without batching dependent
mutations.

Anthropic's guidance supports just-in-time retrieval and measuring redundant
calls, tool errors, tokens and task accuracy together. That supports the approach,
not a Gyro performance claim.
[Context guidance](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents),
[tool evaluation guidance](https://www.anthropic.com/research/writing-tools-for-agents).

**Exit:** fewer observed recovery/error rounds and improved held-out task success,
with no loss of required source, diagnostics, approval behavior or edit scope.

### 4. Make long sessions retain the right facts

Evaluate the existing checkpoint/retrieval and recoverable-evidence policies
separately. The retained state should distinguish exact user constraints,
corrections, observed outcomes, remaining work and agent assertions. Recover old
evidence by reference; revalidate live files before editing. Test resumed and
fresh-recovery paths explicitly.

Add verifiers for obeying an earlier correction after compaction, recovering an
exact fact from omitted output, and detecting a changed file. Require observed
compaction/recovery events for claims about those mechanisms. A long transcript
alone does not exercise them.

**Exit:** better correct completion on held-out long tasks, with bounded overhead
and no forgotten constraints. A smaller summary is not the acceptance criterion.

### 5. Reduce tool catalog overhead where discovery pays off

Evaluate `compact-tool-catalog` on owned runners and `compact-cli-catalog` only
on supported native paths. Test both short common-tool tasks and tasks needing
rare tools. Count discovery rounds and schema reloads. Preserve complete schemas,
validation and approvals at dispatch; retain a reliable full-catalog fallback.

**Exit:** lower total task cost without tool-selection regressions. Smaller schema
bytes alone are insufficient. Keep full catalogs where discovery costs more.

## Provider coverage

| Path | Gyro can improve | Boundary |
| --- | --- | --- |
| OpenAI-compatible APIs, including custom endpoints | Request assembly, shared tools, history retirement, observed loop/usage accounting | Cache parameters and pricing require route-specific support. JSON compatibility needs separate evaluation. |
| Ollama | Shared tools, locally assembled context, retrieval and recovery | Report tokens, latency and local resource usage; do not infer an API bill or assume hosted prefix caching. |
| Codex, Claude, ACP providers using Gyro MCP | Shared tool results, prompt construction, continuation/handoff evidence | Native history, internal tools, reasoning and some usage remain provider-owned. |
| Antigravity | Gyro's prompt and continuation boundary | Its native command stream is not the shared Gyro terminal-result path. |

Shared improvements should be tested across adapters. Provider-specific settings
should follow demonstrated capabilities. Preserve the selected model and effort
during this roadmap's comparisons; automatic model switching and delegation are
separate product decisions.

## Measurement and promotion

For each matched cohort:

`cost per verified task = total observed cohort cost / independently verified successes`

Include failed runs in the numerator. With no verified successes, the metric is
undefined, not zero. Report success rate separately so averages cannot conceal
failures. Report each provider/model/task family before a pooled average.

The existing pilot gate requires at least 20% lower cost per verified task, no
observed matched-task correctness regression, and at most 10% p95 slowdown, plus
complete comparable accounting. Preserve that gate. Three repetitions are pilot
evidence; small cohorts do not establish a reliable production p95 or equivalence.

**Additional product requirement:** “better results” needs a repeatable increase
in held-out correct completion or a predeclared quality measure, such as fewer
constraint violations. Same quality for less money is useful, but does not prove
better results. Expand samples and report uncertainty before a broad claim.

Promote only the policy and routes that qualify. Keep independent rollback and
measure interactions before combining winners. Retest after material provider,
tool-contract or context-policy changes.

## First bounded evaluation proposal

Start with the three frozen repository tasks, baseline versus
`stable-api-prefix`, three paired repetitions, and fresh/resumed conditions on
one owned API route: **36 task runs**. This count is not a generation budget;
multi-turn tasks, tool loops, setup calls and retries add model requests.

Use a bounded smoke subset first to validate integration and receipts, then run
the complete predeclared cohort. Choose the provider/model/effort, current pinned
prices, and finite call/token/currency limits before execution. The checked-in
templates intentionally contain no providers and zero execution budgets.
No paid evaluation or default promotion is authorized by this planning document.

After the first cost result, prioritize the baseline's largest verified failure
class for the quality improvement, then repeat with another provider family and
held-out real tasks. This delivers evidence for both halves of the goal before
adding more policies.

## Open questions

- Which provider paths and task families account for most actual Gyro use?
- Where do observed task costs concentrate: uncached input, output/reasoning,
  failed requests, repeated tools, or background calls?
- Which existing policy produces the best paired cost/quality trade-off?
- Which native providers expose enough usage to support a complete claim?

## Implementation progress — 2026-11-15

After approval to start, the existing report gained paired quality outcomes,
token/cache breakdowns with unknown-value coverage, and fixed failure classes.
Qualification gates and runtime defaults are unchanged. The existing pilot test
command now covers these diagnostics and preparation safeguards.

`scripts/prepare-efficiency-prefix-pilot.mjs` prepares the two-run smoke and
36-run paired specs from the frozen corpus, with providers/prices empty and
zero execution budgets. The prepared artifacts are in
`artifacts/efficiency-prefix-2026-11-15/`. The paired cohort includes 114 user
prompts before tool loops and retries; the smoke pair includes two.

`pnpm test:efficiency-pilot` passed (40 fixture verifiers/report gates, provenance,
and new diagnostics/preparation checks). No live provider generations ran.
Provider/model, effort and authorized spend remain required for the smoke run.
The pre-existing edit in `apps/desktop/src/remote-access/root.tsx` was untouched.
