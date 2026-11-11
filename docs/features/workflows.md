# Local reusable workflows

Implementation status: local source, unit tests and production-component browser
fixtures. Native WebView and live-provider release acceptance remain open.

Open **Automations → Workflows** to create or edit a project recipe, or use
**Save as workflow** in a chat’s options/completed turn. Recipes live in
`.gyro/workflows/<id>.json`; saving does not call a provider or start a job.
The source chat and chosen root determine authority. Private app state is not a
project root.

Recipes contain typed inputs, generic role names, fixed sequential agent,
second-opinion review and verification steps, named outputs and completion
requirements. Provider/model choices, current input values, command arguments,
run history and extraction artifacts remain in the private store. Definitions
have a closed bounded `gyro.workflow.v1` schema; unknown versions are preserved
as disabled library entries. There are no loops, remote includes or evaluation.

**Setup and run** requires explicit provider/model bindings and access ceilings.
CLI roles keep CLI authentication; API roles use configured API billing. The
recipe cannot grant Full access. Review/extraction roles currently support only
API/Ollama adapters with a no-tool path. Task bindings preserve argv boundaries,
working-directory identity and manifest fingerprints; changed manifests require
inspection and rebinding. Native capability policy, approvals, sandbox,
cancellation, credentials filtering and task receipts still govern execution.

Manual launches and schedules use the existing automation scheduler with a typed
workflow binding. Stable operation IDs prevent duplicate launches. Schedules pin
the recipe and setup version; updating one requires reviewing the new version
and the unchanged schedule timestamp. Existing prompt schedules stay available
under **Schedules**. Unsupported stored execution configurations are preserved
and excluded from dispatch, rather than interpreted as legacy prompts.

Review steps currently inspect recorded applied file changes from their referenced
agent turn. A read-only turn without recorded changes cannot supply that review
input and needs attention; report-only workflows can omit that step.

A workflow reserves its checkout before the scheduler claims the job. Ordinary
chat and CLI execution hold shared checkout leases; workflows need exclusive
ownership. Each run has a 30 minute deadline and one acknowledged attempt per
step. The current coordinator supports local checkouts, including separately
opened external worktrees. Gyro-managed private worktree execution is disabled
with an explanation. Completed requirements and execution completion are separate:
open findings, incomplete review, missing outputs or failed verification leave
**Needs attention**.

**Runs** exposes pinned inputs, step chats/approvals, exact outputs, review
findings counts, elapsed time, ledger call/token counts and actual verification verdicts. Stop cancels current work;
pausing a schedule also stops its current run. Restart recovery interrupts
uncertain work and pauses its schedule without replaying it. **Inspect retry**
requires inspecting prior actions and acknowledging that an unfinished step may
repeat side effects. A bounded Git/workspace witness is checked again when the
continuation starts. Completed steps are copied into a new linked run. The prior
run and its outputs remain available; completed steps are never automatically
re-executed. Workspaces too large for the witness require a new explicitly
configured run. Run-record deletion requires an inactive run and removes its
private inputs/outputs; linked chats have separate deletion controls.

Extraction captures at most 20 selected available turns and 64 KiB of redacted,
hidden-marker-stripped source evidence. Unfinished/cut-off tasks require an
explicit unproven-draft acknowledgment. Inspect the exact input before choosing
a model. Extraction is a separate metered call; it cannot run tools. Strict JSON
validation precedes an editable draft. Saving and running remain separate actions.
Cancellation/restart preserve partial output without automatically retrying.
Private extraction drafts have independent deletion controls.

Verification artifacts:

- `scripts/check-workflows-browser.mjs` and
  `docs/screenshots/2026-11-10-v012-workflows/manifest.json`: synthetic production
  components; library/editor/setup, queued launches, conflicts, stale bindings,
  extraction, inspection, cancellation, keyboard focus and run detail.
- Core workflow/automation tests: schema, isolation, replay protection, revision
  checks, root leases, schedule compatibility and completed-prefix continuation.
- Desktop tests: selected-turn capture and exact current task binding, including
  changed manifest rejection. Loopback HTTP tests verify advisory no-tool
  transport and forged-call rejection without credentials or paid providers.
