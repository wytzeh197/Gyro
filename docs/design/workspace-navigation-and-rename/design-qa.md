# Workspace navigation and rename QA — 2026-10-11

## Result

Workspace opens cross-file definitions and references through the host editor,
including unopened files. Split panes share a canonical file model while keeping
their own cursor and viewport. Back and Forward retain a bounded location history.

F2 and the editor context menu open Rename symbol. Prepare Rename supplies the
initial name where supported. A per-file diff preview precedes Apply rename;
changes remain unsaved. The Workspace bar exposes affected drafts, Undo rename,
and Save all. Cancellation ignores late replies and releases unchanged temporary
documents.

The edit planner accepts both `changes` and versioned `documentChanges`, validates
UTF-16 ranges, and rejects overlapping edits or unsupported resource operations
as a whole. Unopened targets are read, synchronized, and snapshotted before the
final request. Buffer versions and disk hashes are checked again before apply.
One acknowledged reducer batch changes every target; recovery is written before
that batch. Undo preserves earlier unsaved text and refuses to overwrite newer
edits. Save all uses the existing per-file save contract, so partial disk saves
remain possible and are reported explicitly.

Recovery includes dirty buffers without tabs. Closing a split or the last visible
group preserves background drafts. Save responses preserve typing that happened
while the save was running. A failed or corrupt recovery store is reported rather
than silently truncating an accepted rename.

## Composition and accessibility

The editor implementation lives in focused modules under
`apps/desktop/src/editor/`. Native language sessions expose initialized
capabilities, use monotonic UTF-16 document versions, synchronize inactive dirty
documents, and protect editor snapshots from disk-only tool queries.

`WorkspaceRenameDialog` and `WorkspaceEditBar` live in dedicated UI modules and
reuse the primary/secondary button classes and Monaco diff editor. Styling uses
the existing surface, pane, text, muted, border, radius, spacing, heading, support,
accent, danger, scrim, control-height, and focus-ring tokens. The Workspace shell
reserves a grid row for the changes bar above the editor.

The native dialog traps focus. Preparation returns focus to the name input;
preview focuses Apply rename. Enter previews/applies, Escape cancels even while
busy, and closing restores the previous focus. Busy requests focus Cancel so a
disabled input cannot send Escape to the editor underneath. Busy status uses `role="status"`;
errors use `role="alert"`. Back/Forward also use Ctrl-minus/Ctrl-Shift-minus;
Save all uses Cmd/Ctrl-Shift-S.

## Automated checks

Passed:

- `pnpm check` — UI and desktop TypeScript.
- `pnpm smoke:workbench` — workbench guards and UI tokens.
- `pnpm --filter @gyro-dev/desktop build` — production Vite bundle; existing
  large-chunk warning remains.
- `node scripts/check-guard-registry.mjs` — 89 registered guards.
- `node --experimental-strip-types scripts/check-workspace-document-uri.mjs` —
  canonical Monaco/LSP identity, Unicode and reserved filename characters,
  malformed and unsupported resources.
- `node --experimental-strip-types scripts/check-workspace-edits.mjs` — actual
  planner and reducer behavior, versions, UTF-16, atomic rejection, recovery
  limits, split closure, undo, and save races.
- `node scripts/check-editor-language-sessions.mjs` — 12 behaviors using the
  shipped transport manager, including dirty sibling synchronization, shared
  server families, stale responses, startup retry, disposal races, and rejecting
  targets whose live text belongs to a different server session.
- `node --experimental-strip-types scripts/check-editor-recovery.mjs` — actual
  journal round trips, background restart, dirty indicators, quota/capacity
  failures, corrupt storage, and newer persisted drafts.
- `node --experimental-strip-types scripts/check-source-control-review.mjs` —
  existing review-tab lifecycle after the shared diff cleanup fix.
- `pnpm test:workspace-browser` — static production-component snapshot under
  development React and StrictMode, with all assertions listed below passing.
- Focused native `language_server::tests` and the real
  `real_rust_server_navigates_and_renames_across_files` acceptance test — disposable
  Rust project and installed rust-analyzer, without network access.
- `git diff --check`.

The aggregate `pnpm test` is blocked by the existing `surfaces.tsx` architecture
ceiling: 30,011 lines against 29,926. This implementation extracts the editor
from `App.tsx` and does not change that ceiling. The 67 remaining reliability
commands after the architecture gate were run separately and passed.

The broad Rust runs also have failures outside this feature:

- `cargo test --workspace`: Kimi ACP tests
  `oversized_frame_without_newline_fails_before_the_peer_closes` and
  `resumed_history_replay_is_not_rendered_or_saved_as_the_new_response`.
- `cargo test -p gyro-desktop --lib`: browser knowledge contract test
  `browser_knowledge_contract_matches_runtime_and_examples`.

Other working-tree changes are present; this report does not attribute them to
the Workspace implementation. Changes remain uncommitted.

## Browser evidence

The static fixture mounts the production editor, rename controller, reducer,
recovery journal, and composed UI with explicitly mocked LSP/disk ports. Its
initial state includes dirty `main.ts` and unopened `greeting #é%.ts`. The runner
builds an immutable fixture snapshot to prevent development reloads during QA.

Observed in the browser:

- F12, Cmd-click, and reference results open the target and selection. Split
  cursor/scroll state survives navigation and shared content changes.
- F2 and the actual context menu open the host dialog. Keyboard preview, Apply,
  Cancel and Escape work, including cancellation during a delayed response.
  Late replies leave the cancelled operation unapplied.
- Apply/Undo preserve the initial dirty text and update unopened targets.
  Source changes and disk changes during the final request or after preview
  reject the whole transaction.
- A version-null edit for a dirty foreign-root file is rejected before hydration.
  A rename started locally inside that second root succeeds and can be undone.
- Reload restores both unsaved documents. An injected target save failure saves
  the source, identifies the failed target, and keeps that target in recovery.
  Retrying succeeds; a further reload leaves saved text clean.
- At 860×620, Monaco's measured width is 860px within an 860px container; editor
  height is 426px. The bar occupies 33px and the shell has no horizontal overflow.
  The reusable editor wrapper has `min-width: 0` to allow real resizing.
- Preview cancellation releases its models without teardown exceptions. The
  shared diff wrapper owns model disposal, detaches before release, waits for
  Monaco's queued cancellation, and preserves models reused by another editor.

Zero unexpected browser exceptions. Nine known Monaco Delayer cancellation
events during disposal/view restoration remain in the test log; the runner
classifies those narrowly and fails on other exceptions.

Captured and visually inspected:

| State | Evidence |
| --- | --- |
| Dark preview, 1440×900 | [rename-dark.png](rename-dark.png) |
| Light preview, 1440×900 | [rename-light.png](rename-light.png) |
| Recovered drafts, 860×620 | [workspace-recovered-860x620.png](workspace-recovered-860x620.png) |
| Partial Save all failure, 1440×900 | [workspace-partial-save-dark.png](workspace-partial-save-dark.png) |
| Rejected cross-root edit, 1440×900 | [rename-foreign-root-rejected.png](rename-foreign-root-rejected.png) |

## Evidence limits

Fixture interactions prove renderer wiring, keyboard/mouse paths, guarded edit
transactions, and browser-local recovery. Native Rust acceptance independently
proves real server initialization and cross-file definition/reference/rename
requests. They do not constitute a packaged Tauri/WebKit end-to-end run, native
restart persistence acceptance, or a real TypeScript-server run. Density,
interface-size, and accent combinations have not received a complete screenshot
matrix. Full release acceptance remains outstanding.

This first slice supports text edits within the source document's trusted root
and language-server family. Each root supports independent navigation and rename;
a rename spanning separate roots or server families is rejected because its
source server cannot prove that it has the other buffer's live text. It also
rejects create/rename/delete resource operations. Recovery admission currently allows
30 dirty documents, 500,000 combined working/saved characters per document, and
1,000,000 combined characters overall. Exceeding those limits or storage capacity
prevents rename application with an explanation. Transaction undo is held in
memory; restart preserves the unsaved documents but does not restore its Undo
rename button. An installed language server remains required.
