# Context and usage audit — 2026-09-16

Scope: current dirty `release/v0.1.0-alpha.48.5` workspace. Source review and local regression tests, not a live billing reconciliation or paid model quality benchmark. Existing concurrent work was preserved.

## Changes verified

- First-turn OpenAI and Claude wrappers now retain exactly one complete side-panel guide when shared context already includes it. The guide is 2,259 UTF-8 bytes; one redundant copy is removed in affected prompts. No instructions are summarized or deleted from the remaining copy. Standalone wrappers still include the guide.
- Browser tree deduplication keeps the original traversal budget. The stricter accounting introduced during the preceding browser change was reverted because it could expose fewer elements. The compact fixture remains 356 → 235 JSON bytes (34% smaller), with control names and depth-boundary summaries retained. This is not a measured token or billing reduction.
- No model, reasoning effort, tool schema, tool availability, image support, history limit, or compaction trigger was reduced in this audit.

- Follow-up implementation: complete Ollama turn measurements now reach the ledger; handoff selection counts conversation messages rather than tool events within the existing 1,000-event read bound.

## Findings and coverage

| Area | Current evidence | Assessment |
| --- | --- | --- |
| Standing instructions | `lib.rs`: shared provider context and OpenAI/Claude prompt wrappers both supplied the side-panel guide | Exact duplication fixed and regression-tested |
| Resume prompts | `PromptTurn` omits standing guidance on native resume and retains changing mode, approvals, goal and plan state | Existing approach preserved; no additional prompt trimming |
| Tool access | Capability descriptors and mode-specific schemas drive advertised tools; browser capability and provider manifest checks pass | No tools removed; existing policy restrictions preserved |
| Browser observations | `session_browser.rs` supplies bounded structured trees and separately requested image evidence | Repeated wrapper names removed; traversal coverage preserved |
| Attachments | Explicit editor/browser snapshots are included; browser image expansion checks identity and integrity and deduplicates references | Preserve explicit content and image bytes; no image downsampling or attachment omission introduced |
| Composer meter | `context-usage.ts` combines reported context with newer text estimates; stream checkpoints retain character baselines | Focused meter/stream checks pass. Before provider reporting, estimates do not capture every instruction, schema, attachment or provider-side tool result |
| Claude accounting | Request usage is separated from turn-wide billing; cache buckets are included in occupied context | Existing parser and cached-input tests pass |
| OpenAI app-server accounting | `provider_context_usage_from_app_server` reads `tokenUsage.last`; runner copies that reading to `billed_usage` | Unresolved: last-request occupancy can undercount a multi-request turn. Needs cumulative-usage deltas with explicit turn/resume baselines and duplicate-event handling |
| Fallback ledger estimates | `record_provider_usage` estimates only `request.message` and final response when billed usage is absent | Unresolved: misses assembled instructions/history/attachments/tool cycles. Marked estimated, but unsuitable as an accurate spend ceiling |
| Ollama ledger | Runner now aggregates input/output counts across all successful tool rounds separately from final context occupancy | Fixed for completed turns with complete measurements. If any round omits either count, retain estimated provenance; failed/cancelled runs still use the existing fallback |
| Provider handoff history | Reads the existing bounded 1,000-event window, selects conversation, removes the current user message, then retains the latest 40 messages with existing 2,000/400-character limits | Fixed the 40-event crowding defect. Tests cover 100 intervening tool events and preserved prompt bounds. Older-than-window history and character clipping remain limitations; native resume avoids this path |
| Usage guards and quotas | Core tests cover pauses, rate ceilings, budgets, cached inputs, measured/estimated separation, and failures | Guard logic passes its tests; enforcement quality still depends on accurate adapter inputs. Token counts are not currency spend |

## Follow-up priorities

1. Correct per-turn accounting at each adapter boundary. Record full rendered-request estimates where measured usage is absent; preserve estimated/measured provenance. Test multi-tool turns, cumulative counters, repeated notifications, retries and resumed sessions before changing budget behavior.
2. Improve handoff continuity without silently shortening history: retain durable user constraints, goals/plans, unresolved work, and references to original evidence. Select conversation records rather than allowing tool-event volume to consume the history window. Verify long-chat handoffs against native resume.
3. Make the meter's estimate limitations explicit for pending attachments and provider-hidden context. Avoid presenting cross-model carried counts as a precise measurement of a newly tokenized request.
4. Measure representative turn payloads and outcomes before further savings claims. Prefer exact deduplication and reuse over smaller models, removed tools, lower reasoning effort, or more aggressive clipping.

## Validation

- Follow-up fixes: Ollama aggregation test and both handoff tests passed; all 13 desktop context tests, usage-ledger checks, capability-manifest checks, and Git whitespace checks passed.

- Desktop Rust prompt suite: 11 passed; context suite: 13 passed; usage suite: 22 passed, 3 live-account tests intentionally ignored. Filters overlap; these are not distinct-test totals.
- Core usage suite: 30 passed.
- Composer context and live stream checks, usage ledger checks, provider capability manifest, all 15 browser capability contracts, and browser observation checks passed.
- Desktop TypeScript check and Git whitespace check passed.
- No live provider requests or billing reconciliation were performed. Tests establish the covered contracts; they do not establish equivalent answer quality across all workloads.

Changes are local and uncommitted. Rust changes need a rebuilt/restarted app before runtime use.
