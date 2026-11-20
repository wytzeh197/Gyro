# Second-opinion reviews

Implementation status: local source, focused tests, loopback transport checks and
production-component browser fixtures. Native/live-provider release acceptance
is separate.

In a workspace chat, type a task followed by `/second-opinion` and press Enter to choose the command. The command stays in the composer while you pick a connected reviewer. Search across all connected providers by model name or ID, or narrow the list with the provider chips below the search field. Each model shows its context size, and the current reviewer is marked with a check. The search field and provider chips stay visible as you scroll. Its provider logo and model name appear immediately after the command. Click the pill to change or remove the reviewer. Sending starts the task with the chat’s current model.

After the builder finishes, Gyro captures the file changes it can attribute to that turn and queues one independent review. The turn’s work timeline shows when the request is sent and when the selected model starts reviewing the changes. Once the review finishes, the builder’s answer appears with a **Review Second Opinion** button beneath it. The button shows the reviewer’s provider logo and opens that turn’s review in the right panel.

The panel reads like a Markdown document. Its heading shows the reviewer’s provider logo followed by the model name on the right. The document shows the reviewer’s summary, findings and suggested fixes. A current file reference opens the cited line in the editor. References to an earlier version open the captured diff. **Fix in chat** adds the findings to the original conversation’s composer and preserves any text already there. You can edit the prompt before pressing **Send**. When there are no outstanding findings, **Prompt in chat** prepares a follow-up about the review.

If the reviewer checks only part of the change, the turn shows a notice alongside the result. If a review fails, is cancelled, or has no eligible changes, the turn shows its status and the builder’s answer. Claude Code reviews use a fresh subprocess with tools disabled. Ollama and OpenAI-compatible connections use a fresh tool-free API request. Each review uses the selected connection.

For a manual review, open **Review → Second opinion**, **Review with an agent** on a completed turn’s file summary or in Workspace source control, or **Review current file with an agent** in Workspace diff. Choose the root, scope and reviewer, then inspect the captured input before starting. Review details show call and token counts, usage receipt availability and elapsed time.

Input contains bounded complete before/after bytes, hashes, available modes,
original request, selected project memory, scope identity and visible exclusions.
Historical review reconstructs stored mutation evidence and never substitutes
current disk for missing history. Sensitive, binary and symlink content is
excluded. Partial coverage, invalid output and cancellation do not become a clean
completed review. Findings require exact supplied-file coverage and narrow
captured anchors. Current applicability is separate from historical completion.

In the manual review tools, select findings to prepare an inspectable composer draft or **Send for fixes**.
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
