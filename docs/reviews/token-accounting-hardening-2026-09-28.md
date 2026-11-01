# Token accounting hardening — 2026-09-28

## Audited screenshot

The displayed ~3.9M count matches the provider's cumulative usage delta for the completed turn:

| Count | Tokens |
| --- | ---: |
| Previous cumulative total | 25,130 |
| Final cumulative total | 3,920,119 |
| Turn total | 3,894,989 |
| Input, including cached input | 3,879,281 |
| Cached input, a subset of input | 3,749,120 |
| Output, including reasoning | 15,708 |
| Reasoning, a subset of output | 2,825 |

Evidence: local Gyro session 8d8b0088-8458-41c3-868a-7ada7334c0a3, turn bb727c90-2f59-4791-bca0-ba025338b339, compared with Codex rollout thread 01a0e7ff-ced9-7122-b2cf-2dc4633f5418. No historical data was rewritten. The saved estimate marker was appropriate because that execution did not establish a verified resume baseline. The retrospective comparison verifies this particular total.

Usage across a turn includes repeated context over multiple model requests. These counts do not measure the current context window or establish a monetary charge.

## Changes

- Codex resumes attempt a bounded pre-dispatch baseline read from the exact provider-supplied rollout, validating the thread identity. Missing or invalid baselines remain uncertain. Duplicate cumulative notifications do not add spend; decreasing readings preserve the prior count and mark uncertainty.
- Both thread and turn identities gate usage updates. Notifications arriving before the turn-start response are replayed only after their identity can be checked.
- Claude message IDs deduplicate repeated usage snapshots; a final result replaces accumulated request usage and prevents late request frames changing it.
- OpenAI-compatible accounting preserves reported totals across partial and repeated frames. Live and completed totals share the observed aggregate.
- Explicit zero stays zero. Missing sides and contradictory totals are not silently marked measured. Arithmetic saturates; cache and reasoning stay within their parent counts.
- The UI rejects invalid or unsafe numeric counts, preserves estimate markers, displays cached input, and shows exact counts in the tooltip. Missing historical usage displays “Usage unavailable”; a total-only reading does not invent a zero breakdown.

## Verification

- Full gyro-core library suite: 409 passed.
- Full gyro-desktop library suite: 452 passed, four existing tests ignored.
- Workspace TypeScript checks passed.
- Token display, usage ledger, context usage, provider stream ordering, and chat persistence guards passed.
- Regression cases include the audited 3,894,989 total, multi-request resumes, duplicates, stale and wrong-identity events, missing baselines, partial usage frames, reported zero, cache/reasoning subsets, invalid numbers, and disk reopen for completed/failed/cancelled ledger entries.

The new provider behavior was verified through unit/integration fixtures and compilation. It has not been exercised through a newly launched live-provider turn or installed desktop rebuild; the four ignored tests remain unexecuted.
