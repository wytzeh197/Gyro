# Token efficiency

Gyro reports what it controls and what it can observe separately. Native CLI
history and internal loops remain provider-owned. API runners own their messages
and Gyro tools. Subscription allowance is not represented as a monetary token
bucket.

## Current behavior

Usage Limits contains an Efficiency group. Numeric attribution and immutable API
price snapshots are available without generation calls. Routine and Deep are
explicit profiles and apply only when the model supports the selected effort
and no effort was already supplied. Standard preserves current behavior.
Parallel agents require an explicit task request or the explicit setting;
reasoning effort alone no longer authorizes delegation. Explicit opt-outs win.

New context policies are experimental and **off by default** until the paired
pilot qualifies them. Turning off Context efficiency restores the preceding
context behavior. Existing usage guards, approval policy, token-budget meanings,
and the auto-compaction threshold remain independent.

The experimental compact tool catalog is independently off by default. On
owned API and local-model requests it keeps common tools directly callable and
exposes the remaining tools through the catalog and its dispatcher. The
dispatcher validates the selected tool and its full argument schema and uses
the same capability broker and approval policy. This switch does not change
native CLI tool catalogs; `compactCliCatalog` below is the separate switch for
them. Compare discovery, retries and cache behavior before enabling it.

- Structured evidence parses Cargo tests/compiler JSON, Node TAP, TypeScript
  diagnostics, and ESLint JSON. Exact failures and exit codes are preserved;
  partial or unrecognized output retains the raw paged view. Earlier output IDs
  identify individual executions; eviction and source truncation stay visible.
- Direct OpenAI-compatible requests can separate vetted stable instructions from
  changing context and order tool definitions consistently. Untrusted source,
  history, user messages, and task records remain outside the system prompt.
  Cache options are confined to the official OpenAI endpoint, based on the
  [documented Chat Completions controls](https://developers.openai.com/api/docs/guides/prompt-caching).
  OpenRouter's `anthropic/` routes get the
  [documented automatic cache marker](https://openrouter.ai/docs/features/prompt-caching).
  That marker has only offline test coverage so far; it has not been sent to a
  live OpenRouter route, and a rejected marker would fail the request.
  Generic gateways are never assumed to support them. Native histories are not
  rewritten. Claude CLI launches set `FORCE_PROMPT_CACHING_5M=1`, because the
  default one-hour cache write costs 2x input against 1.25x for five minutes.
  The cache-assembly experiment also retains tool definitions when a tool-round
  limit requests a final checkpoint, using `tool_choice: "none"` on documented
  OpenAI and DeepSeek HTTPS routes. Execution remains disabled by the local
  round guard. Other endpoints keep omitting tools; this adds no probe or model
  call. Compare actual cache usage and total cost before promoting the policy.
- Task checkpoints preserve exact user-message provenance, the latest agent
  response, objective, live plan, file hashes, observed outcomes, and separately
  labeled agent assertions. They use versioned JSONL events and a rebuildable
  SQLite index. In-flight evidence accumulates locally; checkpoints persist at
  completed/stopped turns, compaction, and explicit checkpoint updates.
- `gyro_task_checkpoint` reads/updates assertions and pages exact retained chat
  history. `gyro_workspace_outline` ranks bounded file outlines using explicit
  paths, observed search and symbol signals, references, and test paths. Normal
  search, range reads, and language-server tools expand the evidence. File and
  buffer identities are revalidated; older summaries are not authoritative.
- OpenAI-compatible and Ollama runners, for every model id they serve, replace
  a tool result older than the newest exchange once it is at least 2 KB.
  Catalog pages stay, because dropping a schema makes the next call load it
  again. The live request keeps the call id, status, summary, and file or
  window identity, and points at the spilled copy instead of asking for the
  same read again. Pixels
  from an earlier screenshot are dropped; the newest image and the user's
  attachments stay. The transcript is unchanged. Auto-compact remains the
  window backstop. Resumed Codex, Claude, and ACP threads keep their own
  history and their own compaction.
- Duplicate reads fold only inside the newest exchange. A later read no longer
  rewrites a message that was already sent, because that rewrite misses the
  provider's cached prefix for everything after it. If a spill fails, the older
  full copy stays in the request.
- `/compact` reports what it actually did. A resumed Codex thread compacts
  inside its own session, which is a model summary of the earlier conversation.
  Every other provider is rewritten locally: the checkpoint either keeps the
  history whole because nothing needed dropping, or replaces the middle turns
  with a one-line digest each. The activity row and the transcript card say
  "condensed" or "kept" for those, never "summarized".
- Three consecutive identical Gyro tool calls with unchanged state/results
  produce a correction notice. Six pause the turn with a checkpoint. Polling and
  waits are exempt; native internal loops are not claimed as visible.
- Phase routes target enabled, configured models. Applying a route is an explicit
  user action while the chat is idle. Current effort must be supported by the
  target. A checkpoint transfers state, stale target bindings are cleared while unchanged native sessions continue, and
  escalation is limited to once per task. There is no background model switching.

The context popover exposes numeric context categories, coverage, estimated API
cost, task receipt totals, and checkpoint details. Unknown usage/prices remain
unknown. Completion and independently verified success are different states.
Price snapshots are immutable, user supplied, and selected by provider, model,
and effective date. Corrections use the original snapshot with corrected counts.
Reasoning is an output subset; cache reads/writes are input subsets.

Owned-runner receipts include bounded generation-attempt and validated tool-request
class counts; a request may be denied or stopped before execution. These counts
do not retain arguments, paths, or result text. Native providers' internal
model and tool loops are unavailable to this accounting. Version 2 retirement
accounting records bytes newly removed by a request rewrite once, not tokens,
replay savings, or money. Earlier receipts and native paths remain unknown, not
zero; mixed-task aggregates report partial coverage. Token budgets act on
observed usage, may overshoot while a request is in flight, and are not invoice
or hard currency limits.

## Pilot and quality gate

`docs/performance/efficiency-pilot.json` contains forty synthetic task fixtures:
eight each for routine edits, unfamiliar-code fixes, multi-file features,
debugging, and longer sessions. Each has a source snapshot, exact instructions,
allowed change paths, an independent verifier, and a reference solution kept
outside the agent's workspace. These are a pilot foundation, not a substitute
for production task evaluation.

Run the offline fixture and report checks:

```sh
node scripts/check-efficiency-pilot.mjs
```

For live evaluation, copy the pilot manifest, choose provider/model/effort values,
and set positive `executionBudget.maxCalls` and `maxObservedTokens`. API providers
also require immutable prices and a positive `maxCostMicros`. Per-turn ceilings
are held constant across variants (`maxTokensPerTurn`, default 20,000); a run
without enough remaining budget is recorded as a budget stop. The template has
zero limits and no providers, so it cannot accidentally start generations.
The template includes `compact-tool-catalog`, `tight-evidence`, `batch-reads` and
`compact-cli-catalog` variants; `combined` does not turn on the last three, so
each is measured on its own first. A separate, explicitly
configured spec can opt into `routine-profile` with provider effort left empty;
that comparison requires recorded Gyro-requested low effort for the variant
and null/default effort for the baseline. A requested effort does not establish
that a provider honored it.

```sh
node scripts/benchmark-efficiency.mjs --spec /absolute/path/to/bounded-spec.json
```

The harness runs isolated stores/workspaces, three paired repetitions per
variant by default, and reverses variant order on alternating repetitions. It
counts setup turns, failed attempts, retries, and supporting calls. Fresh/resumed
session conditions are distinct from observed cache reads; neither establishes a
controlled cold/warm cache. Unknown spend stops further generations. Observed
limits can be exceeded by an in-flight request; provider-side caps are required
for a hard monetary ceiling.

Optional native comparators require reviewed provider CLI argv and an explicit
equivalence description. Multi-turn native comparisons are not inferred; missing
native usage is reported separately and stops additional spending.

JSON and Markdown reports retain failed attempts, unavailable providers, budget
stops, correctness, cache coverage, costs, and p95 time. They qualify an API
variant only with a complete paired cohort, no observed verified-task regression,
at most 10% p95 slowdown, and at least 20% lower cost per verified task. Unknown
cost cannot qualify a savings claim. The gate also requires the exact configured
cohort, complete provider receipts, comparable requested effort, bounded retries,
and a single immutable price snapshot. Reports do not automatically promote
settings or establish production-wide quality equivalence.

Numeric timing traces also record local checkpoint, parser, request-assembly,
retrieval, progress, and cache-control overhead when diagnostics are enabled.
Total task time includes optimization overhead.

No live pilot, production savings claim, model training, learned compression,
or inference-hosting service is included in the offline implementation. Learned
retrieval/compression remain candidates after simpler policies demonstrate value.

## Evidence recovery and catalog continuity (2026-10-31)

Two additional independent experimental switches default to false:
`recoverableEvidence` stores the complete omitted result data as historical JSON,
including nested output and every stream; `retainToolCatalog` carries deduplicated
discovered schemas across whole-exchange compaction. Both require Context
efficiency and Efficiency experiments. Existing model and effort choices remain
unchanged. The paired harness includes `recoverable-evidence` and
`catalog-retention` variants before `combined`; no default promotion is automatic.

Evidence replacement checks persistence first. Failure keeps the original data.
Existing retirement also retains a complete JSON copy behind its preview, rather
than losing secondary fields or suggesting that a mutation be repeated. Copies
may be evicted; the reader reports absence explicitly. Spill results identify
historical evidence, and callers must revalidate live state before editing.
Concurrent writes use independent temporary files before atomic replacement.

Retained schemas use the existing 128 KiB capability-result ceiling, including
appendix framing. In compact-tool mode, overflow or discovery failure restores
the normal catalog and direct-call guidance for the rest of the turn. The schema
appendix never splits a tool call/result pair. JSON compatibility mode continues
to use its existing paged discovery protocol; it cannot switch to native tools
when the model does not support them.

Experimental repeated-work detection recognizes unchanged sequences of one to
four calls. It gives a correction after three complete repetitions and pauses
after six; a two-call loop therefore warns after six calls and pauses after
twelve. Arguments, workspace state and outcomes must match at every position.
The detector retains at most 24 fingerprints and does not count the rotating
phases of the same loop as new corrections. Exact terminal wait/read, workspace
output-read and agent wait/report capabilities clear the history; changed
arguments, state or outcomes break the matching sequence. A resumed turn starts
a fresh detector. No length-based task cutoff or extra model call is added.

Owned receipts expose numeric `efficiencyEvents`: catalog discoveries,
rediscoveries after compaction, catalog fallbacks, spill recoveries/failures, and
repeated-call notices/pauses. A recovery counts one paged read, not a whole file.
Task totals include coverage, and benchmark records carry cumulative task event
counts. No arguments, paths, schema text or result text are retained in these
counters. Legacy/native counts remain unavailable rather than invented zeros.

## Provider cost experiments (2026-11-02)

Three more independent switches default to false and need Context efficiency and
Efficiency experiments. A switch that is off is not written to the config, because
`deny_unknown_fields` makes an older build reject the key. Turning one on writes
it, so an older build sharing that config then refuses to load it.

- `tightEvidence` applies to OpenAI-compatible and Ollama runners. It drops the
  preview from a retired tool result and keeps its identity, window, failure state
  and a pointer to the complete spilled copy. A failed spill keeps the original.
  Offline simulation shows no loss at any tested result size, where today's
  preview loses money on 3-5 KB results on cached routes. The simulation assumes
  no extra re-reads, which only a live run can check.
- `batchReads` adds system guidance on the same runners to send independent known
  reads together. It does not apply in compatibility mode or Council. Existing
  guidance already asks for batching and DeepSeek still measured 1.39 calls per
  generation, so wording may not change behavior.
- `compactCliCatalog` serves the short tool list and the `gyro_tool_invoke`
  dispatcher to Claude, Codex, xAI and Kimi chat runs. In the Normal list that is
  47.6 KB reduced to 14.6 KB. Gemini, Cursor and OpenCode keep the full list until
  their approval handling has been read, and Antigravity has no Gyro tools. Panes
  keep the full list. Older prompt text can still name a tool directly, and the
  CLI refuses that name in this mode, so the model recovers through the guidance.
  ACP rows may show the CLI's own title for a dispatched call. Discovery adds
  rounds, so short turns that need deferred tools can cost more.

Live evaluation remains pending. Before a paid pilot, supply immutable prices and
explicit finite spending limits. Run the unchanged model/effort paired cohorts,
then add frozen repository tasks for an unfamiliar bug, a multi-file change with
verification, and a long session that forces evidence recovery and compaction.
Use exact snapshot IDs, independent verifiers, the same permissions, and three
paired repetitions. Include failed work and recovery calls. The existing 20%
cost-per-verified-task and 10% p95 latency gates remain in force; passing fixture
checks or reducing schema bytes does not establish live savings.
