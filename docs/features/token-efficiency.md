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

- Structured evidence parses Cargo tests/compiler JSON, Node TAP, TypeScript
  diagnostics, and ESLint JSON. Exact failures and exit codes are preserved;
  partial or unrecognized output retains the raw paged view. Earlier output IDs
  identify individual executions; eviction and source truncation stay visible.
- Direct OpenAI-compatible requests can separate vetted stable instructions from
  changing context and order tool definitions consistently. Untrusted source,
  history, user messages, and task records remain outside the system prompt.
  Cache options are confined to the official OpenAI endpoint, based on the
  [documented Chat Completions controls](https://developers.openai.com/api/docs/guides/prompt-caching).
  Generic gateways are never assumed to support them. Native histories are not
  rewritten.
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
  a tool result or compatibility catalog older than the newest exchange once it
  is at least 2 KB. The live request keeps the call id, status, summary, and
  file or window identity, and tells the model how to read it again. Pixels
  from an earlier screenshot are dropped; the newest image and the user's
  attachments stay. The transcript is unchanged. Auto-compact remains the
  window backstop. Resumed Codex, Claude, and ACP threads keep their own
  history and their own compaction.
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
cost cannot qualify a savings claim. Reports do not automatically promote
settings or establish production-wide quality equivalence.

Numeric timing traces also record local checkpoint, parser, request-assembly,
retrieval, progress, and cache-control overhead when diagnostics are enabled.
Total task time includes optimization overhead.

No live pilot, production savings claim, model training, learned compression,
or inference-hosting service is included in the offline implementation. Learned
retrieval/compression remain candidates after simpler policies demonstrate value.
