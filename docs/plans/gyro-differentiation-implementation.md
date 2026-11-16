# Gyro differentiation implementation

Approved direction: connect requirements, visual fixes, agent handoffs, review findings and reusable workflows. Source implementation and tests are distinct from installed-app and live-provider acceptance.

## Baseline — 2026-11-13

Before edits: `cargo test --locked --offline -p gyro-core local_check --lib` passed 21 tests, including the real sandbox/runner controlled to-do case. This establishes the existing check boundary, not competitive performance.

Real-task comparison scenarios (not yet run):

| Scenario | Starting fault | Required outcome |
| --- | --- | --- |
| Mobile navigation | Menu fails to open at a mobile viewport | Open/close and keyboard behavior work at the specified viewport |
| Broken form | API works, submit handler does nothing | Browser submission adds an item and rejects blank input |
| Small feature | Missing filter in an existing app | Agreed behavior and relevant regression checks pass |
| Agent handoff | Partial implementation with failed verification | Another supported agent continues without losing requirements or repeating side effects |
| Review and reuse | A change contains an anchored defect | Fix, re-review, then repeat with new workflow inputs |

For each comparison record initial revision, requirements, provider/model/effort, elapsed time, manual interventions, repeated explanations, review time, final defects and available usage. Unknown costs remain unknown. Use the same starting state and repeat nondeterministic runs. No real-user or competitor measurements have been performed.

## Design brief

Placement: extend the existing Check dialog and its composer activity. Requirements and results remain beside the work; no new navigation destination.

Composition: existing `gyro-check-criterion`, `gyro-check-result`, report details, buttons, fieldsets and `CheckWorkActivityContext`. Preserve current token-based CSS, dialog keyboard handling and focus restoration. New behavior uses existing control styling, with no new visual tokens.

States: empty requirements offer Add requirement; preparation preserves the draft on errors; review displays the exact requirements/action; running permits stop and background progress; results distinguish Passed, Failed, Not checked and Stale; rechecking requires a fresh reviewed plan. Historical observations remain inspectable. No model claim becomes a verdict.

Initial visible copy: Add requirement; Remove requirement; Check again; Stale; Requirements verified; Needs attention; No requirements checked. Requirement revisions are immutable approved plans; rechecking copies inputs but never approval or verdicts.

## Delivery and acceptance

1. Requirements and evidence: usable empty state, bounded editable requirements, immutable check snapshots, fresh recheck and honest summary. Test missing evidence, mismatched scope, changed files and cancellation.
2. Visual loop: preserve annotation target and viewport, reacquire after edits, verify behavior. Native and live-provider end-to-end acceptance remains required.
3. Handoff: carry bounded structured task context at model switches, with omission disclosure and stale evidence checks. Exercise both provider directions and restart.
4. Review: preserve finding identity through fix and re-review; unresolved/partial review must remain visible.
5. Workflows: save and rerun bounded recipes with new inputs and fresh checks; no inherited execution approvals.
6. Validation: targeted tests, frontend checks, browser fixtures and real installed/provider scenarios. Publish nothing as part of implementation.

## Implemented source changes

- Check supports up to eight editable requirements, immutable reviewed plans, originating-turn references, linked rechecks and fresh approval. A deterministic summary rejects missing, duplicate, unscoped or evidence-free observations; stale results cannot retain passed verdicts. Reports remain inspectable.
- Native preparation validates task ownership and previous-check ownership. Saved reports emit task-linked requirements, results and file snapshots for handoff and extraction.
- Browser annotations identify the exact attached before image, target URL, selector and viewport. Provider context checks image delivery and directs authorized fixes to reacquire the current target and collect after evidence. This is guidance and provenance, not an automatic visual verdict.
- Model-switch handoff includes bounded structured task context alongside recent conversation, honors efficiency/task-state opt-outs, invalidates old proof, and discloses missing context. Attachment references exclude bodies and disclose truncation. Task-check references require revalidation.
- Review again captures current uncommitted files for historical-turn reviews; branch reviews preserve their base. Previous review identity, original paths and request remain attached. Existing native finding-resolution rules remain authoritative.
- Three editable implementation recipes cover bug fixes, browser issues and small features. All require a project verification task and independent review, with fresh bindings. Extraction includes selected historical checks as explicitly stale source context; source turn completion is not presented as a proven recipe.
- New completion and recipe guards run through `pnpm test:differentiation` and the normal `pnpm test` entry point.

## Executed verification — 2026-11-13

| Check | Result |
| --- | --- |
| Desktop TypeScript | Passed |
| Completion evidence/freshness guard | 11 assertions passed |
| Workflow starter dependencies, inputs and authority | All six starters passed |
| Core Local Check | 23 tests passed, including sandbox execution |
| Core task checkpoint | 3 tests passed |
| Native conversation history | 17 tests passed |
| Native selected-source workflow capture | Passed |
| Native annotation prompt/image-delivery regression | Passed |
| Core code review identity, fix and re-review | 10 tests passed |
| Check production UI fixture, explicit `--ui-only` | 35 assertions passed; narrow dark screenshot inspected |
| Review browser suite | Passed, including turn→current-files re-review; 18 capture operations |
| Workflow browser suite | Passed, including all three new recipes; 21 capture operations |
| `git diff --check` | Passed |

Browser evidence uses mocked transport and is not installed WebView or provider execution. Review and workflow captures are in `artifacts/differentiation/`. The Check UI runner reports its temporary artifact directory.

## Remaining acceptance and broader-check blockers

- Run the five real-task baselines above; no competitor, cost, speed or user-preference claim is established.
- Exercise an installed-app annotated fix from selection through target reacquisition and before/after evidence. Prompt guidance alone does not prove this outcome.
- Exercise live Codex→Claude and Claude→Codex handoffs, interrupted work and restart. Unit tests do not establish provider-native continuation.
- Run a real extracted workflow with different inputs and verify its completion evidence before calling the recipe proven.
- The full Local Check browser suite reaches a missing historical fixture, `mockups/subagents-2026-10-30/conversation.html`. The default full suite still fails rather than silently skipping it. The explicit `--ui-only` mode isolates the production Check dialog assertions.
- `pnpm test` stops at the guard registry on unrelated cloud and duplicate ` 2` scripts. The two new guards were wired into the package scripts and no longer appear in that failure.
- `pnpm smoke:workbench` passes its workbench source check, then stops on unrelated `chat.css` color/spacing and CSS budget violations. The safeguards were not weakened.
- Other working-tree changes appeared during this run and were preserved. No commit, push, release or competitive claim was made.

The implementation has targeted evidence, but the complete differentiation plan is not release-accepted.
