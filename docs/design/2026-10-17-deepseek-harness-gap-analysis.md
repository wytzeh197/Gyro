# DeepSeek Harness ↔ Gyro: gap analysis and upgrade plan

Date: 2026-10-17
Subject under review: `deepseek-ai/deepseek-harness` (MIT, TypeScript, "Everything is a Plugin")
Compared against: `crates/gyro-core` at workspace version `0.1.0-alpha.49.7`

## 0. How this was produced

A shallow clone (`git clone --depth 1`) of the upstream repo, then targeted reading of
`docs/subsystems/*.md` plus the `packages/` inventory. Upstream claims below are marked
**(doc)** when they come from the harness's own design docs rather than from reading its
implementation. Gyro claims are marked with the file and symbol they came from and were
read from this working tree, not from memory.

Deliberately *not* done: a full read of ~400 upstream packages. The four mechanisms that
dominate token spend are documented well enough to plan against, and everything else is
breadth we can ignore until the economics are fixed.

## 1. What the harness actually is

A monorepo agent OS, not a CLI wrapper. `packages/` is split into groups — `spine/`,
`core/`, `llm/`, `context/`, `shell/`, `features/`, `packages/`, plus ~40 single-purpose
leaf packages (`spill`, `ptc-runtime`, `session-query`, `subagent`, `skill`, `guard`,
`sandbox`, `goal`, `plan`, `todo`, `jobs`, `schedule`, `workflow`, `deliverables`,
`document`, `browser-use`, `computer-use`, `lsp`, `mcp`, `acp`, `api`, `sdk`, `client`,
`telemetry`). Its thesis is "everything is a plugin" over a Cordis-style DI container:
a capability is a package that declares a seam, and the agent loop composes them.

That architecture is a TypeScript-monorepo luxury. **Gyro should copy the mechanics and
reject the architecture** — a small Rust core with adapters is the product's advantage,
and `docs/roadmap.md` already rules out the autonomous-multi-agent direction that pays
for most of that package count.

## 2. The four mechanisms that make the harness cheap

### 2.1 Spill — offload instead of truncate (doc: `docs/subsystems/spill.md`)

Tool results over an inline budget are replaced in-context by an *ordered preview*
(head + tail, or an ordered subset of text blocks) plus a spill address and a
`retrievalHint`. Text and image results both spill. The consumer — tool result, context
assembly, or the caller — owns the preview/spill decision, and both read the same entry.
Saving is best-effort; if the spill write fails the consumer keeps inline data.

Why it matters: the model keeps a *pointer*, not a copy, and can pay for exactly the
slice it needs later. Truncation loses information permanently and provokes a re-read
that costs more than the original output.

### 2.2 Compaction with anchors (doc: `docs/subsystems/compaction.md`)

Threshold-driven auto-compaction of the transcript (multiple windows, summarization,
"surface replace" of older turns), with *anchors* preserved across the replacement, plus
before/after context-token accounting for every compaction, and a user-invoked `/compact`.

### 2.3 Token meter (doc: `docs/subsystems/token-meter.md`)

Per-node accounting over the request surface — system, tools, history, tool results —
priced per *route* (provider/model), with an incremental fold so accounting stays O(1)
per turn, a `route.hint` the UI can trust, and anchors for known structures. This is what
turns "the context got big" into "this tool output cost $0.004 at this route".

### 2.4 Programmatic tool calling (doc: `docs/subsystems/ptc-runtime.md`)

`ptc-runtime` lets the model write a small program that calls allowlisted tools, so N
tool calls collapse into one round trip. A per-tool runtime allowlist bounds what the
program may touch (agent authorization is separate), `store` is off by default, execution
ends cleanly at a total timeout, and large results spill to a retrieval handle.

This is the single largest routine multiplier: a "read six files and grep three patterns"
turn costs 9 full-context round trips today and 1–2 with PTC.

### 2.5 Two cheap extras worth stealing outright

- **`skill` (doc: `docs/subsystems/skill.md`)** — instructions live on disk as `SKILL.md`
  with frontmatter; only a compact index is in context and the body is loaded on demand,
  paged with stable ordering and line numbers. Three layers (built-in → `$DSH_HOME/skills`
  → `<root>/.dsh/skills`), slash invocation, capability checks for platform-specific
  skills. This is an instruction cache, and it shrinks the always-on prompt.
- **`llm-cache-plan`** — a dedicated package whose job is planning provider prompt-cache
  breakpoints, instead of scattering cache hints through adapters.

## 3. Where Gyro actually stands

Verified inventory (this working tree):

| Area | Gyro today | Assessment |
| --- | --- | --- |
| Large tool output | `efficiency/context.rs::retire_stale_tool_results` (drop), `::compact_duplicate_reads` (dedupe), `efficiency/evidence.rs::parse` (structured command evidence) | Good instincts, **lossy**: dropped output must be re-read |
| Compaction | `usage.rs::UsageGuardConfig::auto_compact_percent` (575–585, clamp at 820–825) | A **threshold knob**, not an engine: no anchor summary, no before/after accounting, no `/compact` |
| Prompt cache | `efficiency/cache.rs::apply` — `prompt_cache_key` **only** for `api.openai.com`, `prompt_cache_options` only for `gpt-5.6`/`gpt-6`/`gpt-6-mini` | **One host, two models.** Anthropic gets no `cache_control` at all |
| Cache measurement | `openai_compatible.rs` parses `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`/`cached_tokens`/`cache_write_tokens`; `efficiency/pricing.rs::Price` carries separate input, cached, cache-write and output rates | **Ahead of most tools.** Measurement is fine; *shaping* is the gap |
| Tool loop | one tool per round trip | 3–10× round-trip tax on exploratory work |
| Instructions | `openai_compatible.rs::prepare_owned_model_request` + `stable_tools` + `push_tool_names`; monolithic system prompt; prompt templates only as agent launch args | No on-demand skill loading |
| Progress/loops | `efficiency/progress.rs::Detector`/`Decision` | Parity; harness has no better answer |
| Routing | `efficiency/routing.rs::Route`/`Policy` | Present but not wired to a cost objective |
| Durable work | `efficiency/checkpoint.rs::TaskCheckpoint` (file evidence, verification evidence, user instructions), `automations.rs` | **Better than the harness** as an evidence model; weaker as a job queue |
| Extensibility | tools live in a ~22k-line `apps/desktop/src-tauri/src/lib.rs`; no plugin seam; MCP is *server-side* (`provider_mcp.rs`, Gyro serving Codex) | Adding a tool is a core edit; consuming third-party MCP servers is absent |
| Trust/sandbox | `sandbox/sandbox-exec.sbpl`, policy, process guard, file review, worktrees, approvals | **At or ahead** of the harness for a local-first product |

Headline: Gyro's problem is **not** measurement or trust. It is that the three levers that
reduce what gets *sent* — spill, compaction, cache shaping — are either absent or applied
to one provider. Everything else in the gap list is breadth, and breadth is expensive.

## 4. Gap ranking by tokens saved per unit of work

| # | Gap | Why it costs money | Effort |
| --- | --- | --- | --- |
| 1 | No prompt-cache shaping outside one OpenAI host | Every Anthropic turn pays full input price on a stable prefix; DeepSeek/OpenRouter hit rates are left to luck because nothing guards prefix stability | **S** |
| 2 | Retire instead of spill | Dropped tool output gets re-read; a repo-wide grep is paid for twice | **M** |
| 3 | Compaction is a knob, not an engine | Long sessions either grow unbounded or lose instructions with no anchor | **M** |
| 4 | One tool per round trip | Exploratory work multiplies full-context resends by the number of calls | **L** |
| 5 | Monolithic system prompt | Fixed overhead on every request of every provider | **S** |
| 6 | No cross-session retrieval (`session-query`) | Users re-explain what a previous session established | **M** |
| 7 | No plugin/tool-provider seam | Indirect: engineering cost, not token cost | **L** |
| 8 | No agent-quality eval harness | Cost regressions ship silently | **M** |

## 5. Upgrade plan

Sequenced by leverage (`S` ≈ one focused session, `M` ≈ 2–3, `L` ≈ a release cycle).
Phases 1–3 are pure savings; 4 is the structural win; 5–6 are optional.

### Phase 0 — Ledger first (S)

Nothing above can be proven without attribution. Extend `efficiency/accounting.rs` and
`usage.rs` to emit one row per request: route, prompt tokens by surface (system / tools /
history / tool results), completion tokens, cache read/write actuals, estimated vs billed
cost, and a `wasted` class (`redundant_read`, `spilled_recovered`, `dropped_and_reread`).
Surface as `gyro usage --breakdown`.

*Done when:* every request writes a ledger row, and a 20-turn session can be attributed
per surface without reading provider dashboards.

### Phase 1 — Spill store (S/M)

New `crates/gyro-core/src/efficiency/spill.rs`:

- content-addressed blobs under `.gyro/spill/<session>/<hash>` (session-scoped, GC'd with
  the session);
- threshold per route, not global (a 1M-window model can inline more than a 32K one);
- replacement text: byte/line count + head/tail preview + `spill://<hash>` + one-line
  retrieval hint;
- new tool `gyro_workspace_read_spill(hash, start_line, end_line)` returning a bounded slice;
- `retire_stale_tool_results` becomes the *fallback* for when a spill write fails, not the
  default path;
- reuse `evidence.rs::parse` to decide what is even worth keeping inline (exit code,
  failing assertion, matched lines) before spilling the rest.

*Done when:* a 200 KB grep lands as < 1.5 KB of context, and reading the spill handle costs
only the requested slice.

### Phase 2 — Compaction with anchors (M)

New `efficiency/compaction.rs`, replacing the blunt path behind `auto_compact_percent`:

- keep the last K turns verbatim, summarize older turns into one anchor block;
- pin, verbatim, everything `TaskCheckpoint` already tracks — user instructions, file
  evidence, verification evidence — because those are the facts a summary mangles;
- record before/after context tokens per compaction (feeds the Phase 0 ledger);
- manual `/compact` plus auto at `auto_compact_percent`.

*Done when:* a 200-turn session converges under 40% of window, anchors survive repeated
compaction, and a regression test proves a user instruction issued at turn 3 still governs
turn 190.

### Phase 3 — Cache plan (S) ← cheapest real win, do this first

Promote `efficiency/cache.rs::apply` into `efficiency/cache_plan.rs` with a per-route
policy, and add the invariants that make automatic caching work at all:

| Provider | Mechanism | Today | Action |
| --- | --- | --- | --- |
| Anthropic | explicit `cache_control` breakpoints, 5m/1h TTL, write premium, cheap read | none | breakpoints at system / tools / last user turn; TTL by expected turn count |
| OpenAI | automatic prefix cache (≥1024 tokens) + `prompt_cache_key` | official host + 2 models only | generalise the key to every OpenAI-compatible route behind a host capability flag |
| DeepSeek | automatic exact-prefix cache; reports `prompt_cache_hit_tokens` / `_miss_tokens` | measured, not shaped | guarantee prefix stability; surface hit ratio in the ledger |
| Gemini | implicit + explicit cached contents | none | explicit contexts later; implicit is free |
| OpenRouter / Groq / Together / Fireworks / Moonshot | pass-through, mostly automatic | none | capability flag, no shaping |
| Ollama / local | no monetary cache; context still costs latency | none | report only, never shape |

Prefix-stability invariants (these are the actual work):
sorted tool list (extend `stable_tools`), no clock or request id in the system prompt,
append-only message array, no tool-description churn mid-session, and a test asserting the
prompt prefix hash is unchanged between consecutive turns when tools are unchanged.
Verify upstream cache write/read multipliers against current list pricing before wiring
`pricing.rs` defaults.

*Done when:* turn 2+ cache-hit ratio ≥ 60% on Anthropic, DeepSeek, OpenAI routes in a
recorded scenario, with the ledger showing the per-turn saving.

### Phase 4 — Programmatic tool calling (L)

New `crates/gyro-core/src/ptc/`:

- a small embedded JS runtime (Boa, or rquickjs if performance bites) exposing only
  read-only tools first: read, grep, glob, `workspace_read_range`, `read_spill`;
- per-tool allowlist enforced by the existing policy layer, agent authorization kept
  separate (as upstream does) so a compromised program cannot widen its own reach;
- one program → one round trip; results return as a single message plus spill handles;
- feature-flagged per route via the provider contract's model capabilities and **off by
  default** for models without reliable codegen — a failed program costs more than the
  round trips it replaced.

*Done when:* an "explore this repo" scenario shows ≥3× fewer round trips and a lower
total token count at equal task success, with policy-bypass tests green.

### Phase 5 — Skills and a tool seaim (M)

- `skills/` directory with `SKILL.md` frontmatter; only an index in the system prompt,
  body loaded on demand through a `skill` tool (`list` / `read` / `invoke`). This cuts the
  always-on prompt (gap 5) and gives users a supported extension point without a plugin
  runtime.
- Only afterwards: a `ToolProvider` trait plus manifest so out-of-tree tools stop editing
  `lib.rs`. Do not clone Cordis.

*Done when:* adding a tool or skill touches one new file and one manifest line.

### Phase 6 — Evaluations (M)

A small `crates/gyro-eval` with fixture scenarios that record task success, round trips,
tokens, and dollars *per route*. Run it on every efficiency change. Without this, every
number in phases 1–4 is a claim rather than a measurement.

## 6. Guardrails so this stays cheap

1. **Budgets by class, not one global cap**: per-turn tool output, per-turn history,
   per-session spend. A single cap either strangles long tasks or permits a blowout.
2. **Route on cost, not prestige**: `routing.rs::Policy` should express "cheapest route
   that meets the capability requirement", with escalation recorded in the ledger. Never
   silently upgrade a model.
3. **Spill/compaction thresholds are per-route**, since window size and price both vary
   by an order of magnitude across providers.
4. **Measure the metric you optimise**: cache-hit ratio and tokens-per-completed-task per
   route, in the same table. Optimising tokens alone produces cheap, useless runs.
5. **Cheap defaults, loud overrides**: defaults must be the frugal path, with any
   expensive choice surfaced in the UI as a deliberate one.

## 7. What not to copy

- **The plugin graph.** ~400 packages buy composability at a maintenance cost Gyro does
  not have the surface area to amortise.
- **Autonomous multi-agent orchestration** (`goal`/`jobs`/`schedule`/`workflow` as a
  runtime). `docs/roadmap.md` is explicit that Gyro is not that product; durable jobs are
  a roadmap item on their own merits, not a cost lever.
- **Cordis-style DI.** Rust traits plus a manifest cover the same ground without a
  container.
- **Their trust model.** Gyro's approvals, sandbox profiles, file review and worktrees are
  further along for a local-first desktop app; keep them as the substrate the new
  mechanisms must respect.

## 8. Suggested first three changes

1. `efficiency/cache_plan.rs` + prefix-stability tests + ledger fields (phases 0 and 3) —
   smallest diff, immediate saving on every Anthropic turn, and it makes the rest
   measurable.
2. `efficiency/spill.rs` + `gyro_workspace_read_spill` (phase 1) — removes the re-read tax.
3. `efficiency/compaction.rs` with checkpoint-pinned anchors and `/compact` (phase 2) —
   makes long sessions predictable.

Programmatic tool calling is the biggest prize and the biggest risk; it should start only
after the ledger can prove it paid for itself.
