# DeepSeek desktop path recovery

Recorded 2026-11-09, starting from `d53423a4`. The final isolated debug cohort
passed all four unchanged strict code cases (two fresh, two history-seeded), with
no wrong-test-path proposal in the code turns and no out-of-scope file applied.
A full event audit found one pending memory proposal during read-only history
setup; it was not applied and is retained as a separate model-scope limitation.
This addresses the specific wrong-path acceptance failure recorded during
the backend split. It is bounded live evidence, not a guarantee of future model
behaviour or installed-app/frontend acceptance.

## Failure and change

The original user task named `src/clamp.mjs` and root-level `clamp.test.mjs`.
DeepSeek read `src/clamp.test.mjs` instead, received a missing-file error, then
used whole-file proposal semantics to propose creating that incorrect path.
The scoped reviewer correctly refused it; the test file remained unchanged and
the strict code verifier failed. The filesystem resolver had not rewritten a
correct path: the model supplied the wrong path.

Guidance-only corrections were insufficient. The first four-case cohort passed
code checks but proposed one memory note during read-only setup. After further
scope guidance, another cohort repeated the wrong test-path creation. Both
cohorts remain in [native evidence](native-acceptance.json).

The final change adds an actual tool precondition alongside clearer feedback:

- Desktop `gyro_workspace_propose_edit` requires `createIfMissing: true` before
  a missing file can become a proposal. The default is false. Existing-file
  proposals still require their observed hash; review, cancellation and journal
  application remain in force. The flag expresses model intent and grants no
  authority to bypass approval. Legitimate new-file callers must now set it.
- Missing normal/ranged reads retain their underlying I/O error and explain
  workspace-root-relative paths. When a regular, non-sensitive file with the
  same name exists at the root, feedback names its exact path. The tool does not
  read it, silently switch to it, scan directories or follow a symlink.
- Desktop context preserves user-supplied paths and clarifies that read-only or
  edit-path restrictions cover pending proposals, memory and housekeeping too.
  A fact needed for the next reply can remain in conversation context.

No fixture name or task-specific allowlist was added to production code. The task,
fixture, reviewer, two-file approval scope and strict verifier were unchanged.
The verifier checks all inclusive clamp boundaries, exactly one added regression
and `node --test`; success text from the model is insufficient.

## Verification

Locked all-targets desktop check: zero errors, zero new warnings against the
original warning keys. Desktop suite: **997 passed, 12 ignored**, plus binary/doc
targets passed. Native build, formatting, architecture ratchets and diff checks
passed. Four new regression tests cover missing-file recovery and unchanged file
bytes, error classification, sensitive/symlink candidates, and explicit creation
intent. Core and CLI source were unchanged. Concurrent unrelated UI work was not
included in this fix.

| Cohort | Strict code result | Additional scope observations |
| --- | --- | --- |
| Initial path guidance | 4/4 passed | One memory proposal during read-only history setup, blocked |
| Additional scope guidance | 3/4 passed | Wrong-path create recurred; one memory proposal blocked |
| Final explicit creation + concrete path feedback | **4/4 passed** | Correct code-file paths; one setup memory proposal pending, never applied |

Final cohort: PID 61405, executable verified as `target/debug/gyro-desktop`,
private root `/private/tmp/gyro-split-core-deepseek-explicit-create-ph_4movl`.
Both approved task files were actually applied in every final case. Neither
`src/clamp.test.mjs` nor the proposed out-of-scope memory file existed on disk.
The memory attempt appears in the complete session event ledger but not in the
benchmark's final review list, so additional checks use the complete event ledger.
Exact-path/read-only guidance reduces mistakes; it does not establish perfect
model instruction compliance. No approval or verifier was relaxed. DeepSeek
uses local conversation history, not a native provider resume cursor; records
keep `resumedRequested` and `resumedActual` distinct. Final live cases chose the
correct paths without a failed capability call; deterministic tests exercise the
missing-path and refused implicit-creation branches directly.

Only the existing DeepSeek Flash endpoint/key was used; credentials stayed in
process memory/environment and are excluded from committed evidence. No other
provider setup, purchase or model download was needed. All workspaces/stores were
disposable; installed apps and real chat stores were not changed. Raw logs remain
in the temporary roots; the committed artifacts contain metadata and review
outcomes, not provider conversations or terminal transcripts.

Artifacts: [native cohorts and source fingerprints](native-acceptance.json),
[validation](validation.json), [original failure](../2026-11-09-backend-cli-host/desktop-defaults-acceptance.json).
