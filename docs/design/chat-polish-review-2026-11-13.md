# Chat polish review — 13 November 2026

The chat now leads with the answer, places follow-up actions after the result,
and gives current work a distinct but quiet treatment. This changes the real
chat components and their existing stylesheet, using Gyro's Geist typography,
semantic colors, spacing, radii, and motion conventions.

## Changes

- Move Save as workflow and Continue below the answer and recorded file changes.
  Their original handlers and availability conditions remain intact.
- Give fenced code a language label, an individual Copy control, roomier padding,
  and keyboard access to horizontally scrolling content. Unlabelled fences say
  Code. Copy reuses the existing confirmation component.
- Put tables in a bordered, horizontally scrollable region with readable header
  and row treatment in both themes. Preserve column alignment and table semantics.
- Separate narration from work summaries with consistent spacing. Indent expanded
  tool history along a subtle rule; emphasize the current call with a raised
  surface and the existing running-status color. Long active targets can wrap.
- Increase the completed-work disclosure's hit area, use tabular elapsed time,
  and connect the disclosure to its timeline for assistive technology.
- Consolidate affected CSS rules within the existing ownership and rule budget.
  Replace two pre-existing raw tooltip values with product tokens.

## Design-system checklist

| Check | Result | Evidence |
| --- | --- | --- |
| Existing tokens and components | Pass | Chat style ownership/token guard; existing MessageCopyButton, ChatRun, and disclosure components |
| State is derived from data | Pass for exercised states | Running call settles into history; new work becomes active; failure stays visible; finished work collapses |
| Action hierarchy | Pass | Follow-up actions below the result; existing Send/Stop remains the composer action |
| Status colors | Pass | Running icon uses the running token; failures retain the existing error treatment |
| Keyboard access | Pass for exercised controls | Copy, code, table, and work disclosure have visible focus; Enter expands work and aria-controls resolves |
| Theme and pane layout | Pass for reviewed fixtures | Dark/default, light/large, narrow code/table content, and two- and three-pane screenshots reviewed |
| Native/live provider acceptance | Unverified | No installed-app replacement or provider request was performed |

Browser interactions confirmed that Copy code exactly matches the displayed
content, Save as workflow selects the originating task, and Continue creates a
new fixture turn. The capture fixture lacked workflow read responses and crashed
on navigation; its reads now return correctly shaped sample data. Workflow writes
are explicitly unavailable in that preview. A rich-response scene covers multiple
code languages, an unlabelled fence, a long command, and a table.

## Verification

- UI and desktop TypeScript checks passed.
- Production desktop frontend build passed (existing large-chunk warning).
- Chat-run model checks, response-heading checks, UI-token guard, and diff
  whitespace checks passed.
- The 172-state render-contract sweep had two fixture-state failures: a missing
  chat in `split-narrow-dark-small`, and a closed Environment card in
  `environment-streaming-narrow-dark-small`. Both passed isolated reruns with
  the final source. The original failures and both recheck records are retained;
  this was not an entirely clean single sweep. Development reloads occurred
  during the first sweep, but that is not proof of the failures' cause.
- Refreshed the local baseline for all 172 current cases, retaining all 112
  previous cases and adding 60 existing setup/environment cases. Two empty
  stacked-pane captures in the initial recording were rejected and replaced
  only with separately recorded, contract-checked measurements. The final
  baseline has no missing surface, composer, reply, second pane, or expected
  Environment probes. Its review record lists the replacements.
- The capture runner now waits for the expected populated scene immediately
  before measuring and rejects an empty measurement. Filtered recordings can
  be written to a separate artifact; they still cannot overwrite the repository
  baseline or run through the normal update command.
- A final narrow/light code-reply comparison matched the refreshed baseline;
  an empty-chat contract check passed with the updated capture guard.

This is source and browser-fixture evidence. It does not establish native
clipboard behavior, live-provider reliability, or a complete accessibility audit.
The new treatments do not change the work parser, approval decisions, retry
policy, composer submission logic, or the provider transport.

## Local evidence

- [Finished reply](../../artifacts/chat-polish-2026-11-13/finished-reply-dark.jpg)
- [Expanded working process](../../artifacts/chat-polish-2026-11-13/working-process-dark.jpg)
- [Table and keyboard focus](../../artifacts/chat-polish-2026-11-13/rich-reply-light-keyboard.jpg)
- [Live chat](../../artifacts/chat-polish-2026-11-13/working-chat-dark.png)
- [Two panes, light/large](../../artifacts/chat-polish-2026-11-13/split-light-large.png)
- [Full contract sweep](../../artifacts/chat-polish-2026-11-13/full-render-contract.json)
- [Split recheck](../../artifacts/chat-polish-2026-11-13/split-recheck-contract.json)
- [Environment recheck](../../artifacts/chat-polish-2026-11-13/environment-recheck-contract.json)
- [Previous measured baseline](../../artifacts/chat-polish-2026-11-13/baseline-before.json)
- [Baseline recording log](../../artifacts/chat-polish-2026-11-13/baseline-update.log)
- [Baseline review](../../artifacts/chat-polish-2026-11-13/baseline-review.json)
- [Final build log](../../artifacts/chat-polish-2026-11-13/build.log)

The screenshots use the production React components with sample data. Existing
window-header alignment work and other checkout changes were preserved. Other
workspace/editor/backend and Environment-card work changed concurrently; this
review covers this chat-polish patch and the recorded verification snapshots,
not acceptance of those separate changes.
