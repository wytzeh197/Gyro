# Second-opinion reviews

Implementation status: local source, focused tests, loopback transport checks and
production-component browser fixtures. Native/live-provider release acceptance
is separate.

Open the chat’s **Review → Second opinion** view, **Review with an agent** on a completed turn’s file summary or Workspace source control, or **Review current file with an agent** in Workspace diff. Turn entries retain their recorded turn ID; Workspace entries explicitly assess current uncommitted changes in the bound root. Choose the authorized root,
uncommitted changes, a pinned branch comparison or recorded turn, and an explicit
reviewer/model. Capture and inspect the immutable input before starting. Detail shows ledger call/token counts, estimated/missing-receipt labels and elapsed time. The
implementing composer’s provider does not choose the reviewer. API/Ollama adapters
have a fresh no-tool advisory path; CLI review adapters remain disabled.

Input contains bounded complete before/after bytes, hashes, available modes,
original request, selected project memory, scope identity and visible exclusions.
Historical review reconstructs stored mutation evidence and never substitutes
current disk for missing history. Sensitive, binary and symlink content is
excluded. Partial coverage, invalid output and cancellation do not become a clean
completed review. Findings require exact supplied-file coverage and narrow
captured anchors. Current applicability is separate from historical completion.

Select findings to prepare an inspectable composer draft or **Send for fixes**.
Sending uses the implementing chat’s explicitly displayed saved provider/model,
Normal chat and current policy/approvals. Choose **Queue after current turn** if
the checkout is busy. The private intent pins the selected finding revisions,
source/root, reviewer revision and current file/Git witness. Dispatch revalidates
those values, reserves admission and the source chat, then records the new turn
and `review-fix-requested` link. Changing files, finding disposition, provider or
root while queued blocks dispatch. Sending does not apply a patch or approve an
edit. Cancelling stops the queue or its implementing turn.

A completed turn alone cannot claim a fix: **Fix claimed** requires an applied
mutation recorded for that turn, root and finding path. Other selected findings
remain **Sent for fix**. Human dismissals and anchored re-review resolutions win
concurrently. The implementing turn cannot mark a finding resolved. Only a new
completed re-review with validated anchored evidence can set **Resolved by review**;
partial or missing coverage leaves previous findings open.

Queued intents recover after restart with fresh checks. A dispatch that may
already have executed becomes Interrupted and is never automatically replayed.
Inspect its linked turn before selecting findings again. Review deletion waits
for active reviewer/fix workers and preserves shared snapshots referenced by
another run. Deleting a source stops managed children before artifact cleanup.
Project memory “Forget” does not erase historical explicit snapshots or sent
provider input; review and chat deletion are separate controls.

Evidence: `docs/screenshots/2026-11-10-v012-reviews/manifest.json` and
`scripts/check-code-reviews-browser.mjs` cover synthetic setup, exact diff,
findings, draft handoff, fix queue/cancellation, stale/incomplete/zero states,
dismissal and deletion. Core/native tests cover strict evidence, permissions,
durable transitions and capture. Real loopback API and Ollama HTTP tests prove review/extraction
withhold tools and reject forged provider tool calls; they are not live-model
quality, native-process or billing acceptance.
