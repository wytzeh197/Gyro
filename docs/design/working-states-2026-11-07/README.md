# Gyro working-process states — 2026-11-07

Current visual selection: [three minimal choices](minimal-three/README.md). The earlier ten-sheet set is reference history; the user asked to eliminate nonminimal treatments.

Scope: the agent's in-chat working states. Source inventory and image-generated minimal design proposals, not an implementation. The current checkout has unrelated edits; no app code was changed for these concepts.

## Verified inventory

| Layer | Current variants | Owning source |
|---|---|---|
| Run phase | thinking, working, finalizing, retrying, done, failed, interrupted | `packages/ui/src/chat-run.ts:556` |
| Live pulse modifier | thinking headline or recorded quiet period (`No updates for …`), replacing stale thought copy | `packages/ui/src/chat-run-view.tsx:1073` |
| Run header | Working [for elapsed], Retrying, Worked [for duration], Failed, Stopped for user cancellation, Interrupted; approval/retry overrides | `packages/ui/src/chat-run.ts:1774`, `packages/ui/src/chat-run-view.tsx:287` |
| Activity type | command, search, file, read, memory, context, browser, tool | `packages/ui/src/chat-run.ts:50` |
| Activity result | running, done, failed | `packages/ui/src/chat-run.ts:38` |
| Timeline beat | narration, reasoning-summary status, work, approval | `packages/ui/src/chat-run.ts:138` |
| Command | inspect, test, build; purpose/command, expandable details | `packages/ui/src/chat-run.ts:48` |
| Search/read | project or web; file or image; query/path target | `packages/ui/src/chat-run.ts:61` |
| File operation | content edit; create, rename, move, trash, duplicate; known line counts or unavailable | `packages/ui/src/chat-run.ts:42` |
| Browser | targets/select/preview; open/navigation/back/forward/reload; inspect/read/find; console/network; screenshot/viewport; mouse/click/type/scroll/form | `packages/ui/src/capability-ui.ts:17` |
| Tool identity | capability label, server/tool name, optional note and historical details | `packages/ui/src/chat-run.ts:118`, `packages/ui/src/capability-ui.ts:58` |
| Compaction result | summarized, condensed, kept | `packages/ui/src/chat-run.ts:100`, `packages/ui/src/chat-run.ts:1934` |
| Approval | pending, approved, applied, rejected, cancelled, failed; expiry-specific failure copy; command/file decisions | `packages/ui/src/inline-approval-card.tsx:5` |
| Questions | one question at a time, recommendation, numbered options, custom text, skip/dismiss, answer receipt, send failure | `packages/ui/src/chat-question-popup.tsx:45` |
| Subagent | working, needs approval, stopping, done, failed, cancelled, interrupted; strip and selected-agent rail | `packages/ui/src/subagents.ts:182`, `packages/ui/src/subagents-view.tsx:140` |
| Recovery | transient retry/countdown; terminal error; interruption; sign-in reconnect; user stop; budget notices | `packages/ui/src/chat-run-view.tsx:1046`, `packages/ui/src/chat-run-view.tsx:1130` |
| Message queue | waiting, dispatching, failed; Steer/Retry, Edit, Remove | `packages/ui/src/surfaces.tsx:6473`, `packages/ui/src/chat-message-queue.ts:1` |
| Plan decision | ready, starting; implement or keep planning/revise | `packages/ui/src/plan-mode.tsx:49` |
| Completion | collapsed/expanded recorded work, final answer, file review/undo, unknown counts remain unknown | `packages/ui/src/surfaces.tsx:24275`, `packages/ui/src/chat-run-view.tsx:570` |

Approvals, questions, queue states and subagent statuses are separate from the seven-value RunPhase union. A run can be working while it contains different activity types; they are not independent full-screen workflows.

## Proposed visual direction

Use one coherent family across ten focused sheets: live thinking/finalizing; activity rows; approvals; questions; subagents; memory/context; recovery; completed work; queued messages; plan decisions. Each sheet includes the relevant variants of that family rather than presenting competing redesign directions.

- Keep the real graphite palette, native system type and existing radius/spacing vocabulary.
- One steady run header and one current activity indicator; do not show thinking and retry pulses together.
- Completed work stays neutral and compact; chronological technical evidence opens on demand.
- Narration remains readable prose; paths and commands remain inspectable.
- Waiting/approval uses amber, failure uses red, user stop stays neutral; color never stands in for a label.
- Decision controls stay with their command, question or plan. Approved is distinct from applied.
- Preserve recorded failure, compaction and unknown-count meanings. No fictional percentages or estimates.

Token source: `packages/ui/src/styles-foundation.css:18` (palette), `:135` (radii), `:151` (typography). Current chat styling: `packages/ui/src/chat-design.css:880`; semantic run overrides: `packages/ui/src/ui-upgrade.css:126`.

## Evidence and review limits

The two references in `references/` were captured from the running production React components through Gyro's local browser fixture. They contain demo data and do not prove native or live-provider behavior. The inventory was checked against the current source.

Image Gen is used through the built-in tool. Full prompts and their shared constraints are saved in [prompts.json](prompts.json). Generated screens are proposals with illustrative content. Pixel-perfect token conformance, interaction, keyboard focus, accessibility and provider behavior cannot be established from image concepts; these require implementation review.

## Findings to preserve in an implementation pass

- `runRowText` currently hard-codes `Edited memory` without branching on running/failed status (`chat-run.ts:1932`). The proposed row system should distinguish in-progress, confirmed and failed work.
- Search, context and browser copy use a running-versus-settled distinction; some failure cases still receive past-tense wording (`chat-run.ts:1920`, `:1950`, `:1957`). A failure icon should be accompanied by explicit failure wording when the action did not finish.
- The current fixture contains an example that says `Searched the web for sync.js, queue/*.js`. That demo line is not evidence of a real web search. Revised concepts remove it rather than propagate the wrong scope.
- Current approval color is inconsistent across surfaces: the in-chat header uses `--gyro-warn` (`ui-upgrade.css:126`), while the sidebar approval indicator uses `--gyro-success` (`navigation-design.css:8`). Amber throughout is a proposal to resolve this mismatch, not a claim about the current whole app.
- Approval and compaction outcomes shown together on concept sheets are alternative state specimens, not successive events from a real run.

The first image pass was reviewed and targeted refinements remove excess containers, copied unrelated fixture content, red rejection styling, and a redundant zero-deletion marker. The selected images are linked in [concepts.md](concepts.md). Initial and refinement prompts are retained for reproducibility.

Review checklist: source palette/component grounding **pass**; static action hierarchy and key state distinctions **pass with notes**; exact CSS token sizing **unverified** because these are raster concepts; keyboard and dynamic state transitions **unverified**; no runtime tests run because no runtime code changed. Image-generated icon shapes and final wording require checking during implementation.

Coverage limit: the ten sheets cover state families. They do not draw every combination of row kind × running/done/failed, every browser verb, the long-quiet pulse, every failure category, or every goal/tool-budget notice. Those modifiers are recorded in the inventory or owning source and need the same component rules during implementation. The live pulse and fine-grained budget notices were source-inspected, not exercised against a live provider.
