# Synara source comparison and Gyro UI upgrade

Verified 2026-10-08 against Synara's public repository, pinned at
[`f1b2f7c7e11867eee034d11020b043dcb53f03f9`](https://github.com/Emanuele-web04/synara/tree/f1b2f7c7e11867eee034d11020b043dcb53f03f9)
(commit dated 2026-10-07). The repository is linked by the official
[Synara website](https://www.trysynara.com/). Source was fetched into a temporary
checkout and inspected without running Synara or installing its dependencies.

This is a source-grounded upgrade of Gyro's existing UI. The earlier
[frontend polish QA](../../frontend-polish/2026-10-08/QA.md) establishes the
baseline across the shell, settings, chat, utilities, and startup states. This
pass compares that baseline with actual Synara components and implements the
remaining concrete navigation, review, and worker visibility improvements.
The continuation audit adds session-level approval awareness and an immediately
visible approval destination when opening that chat.
It does not establish identical native behavior or feature parity with Synara.

## Source comparison

All Synara links below are immutable references to the inspected commit.

| Area | Synara source standard | Gyro implementation and evidence |
| --- | --- | --- |
| Typography | [index.css](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/index.css), [appTypography.ts](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/lib/appTypography.ts), and [uiFontSize.test.ts](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/uiFontSize.test.ts) provide settings-driven size tokens. | Gyro retains system type and its existing size scale. New file navigation and worker chrome use shared micro text and motion tokens. Worker metadata now follows the readable 12px token instead of separate 11px and fixed sizes. All 12 appearance combinations were checked. |
| Shell and sidebar | [sidebarRowStyles.ts](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/sidebarRowStyles.ts) shares row height, density, selection, and keyboard focus. | The existing navigation polish already uses density and focus tokens with scaling action gutters. The integrated Review matrix rechecks the complete shell in every appearance combination. Existing navigation and panel placement remain intact. |
| Controls and open tabs | [button.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/ui/button.tsx), [icon-button.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/ui/icon-button.tsx), and [SurfaceContentTabs.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/chat/SurfaceContentTabs.tsx) centralize flat control and tab behavior. | A shared `tab-navigation.ts` now serves companion, terminal, workbench pane, and embedded workspace rail tabs. Left/Right wrap; Home/End select the first/last available tab. Only the selected terminal or pane participates in Tab order. Modified terminal keys retain their existing split placement behavior. Unsupported embedded rail destinations are disabled. |
| Review navigation | [ReviewFileTreePanel.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/ReviewFileTreePanel.tsx) combines file filtering, compact folders, selection, and editor file identity. | Added `ReviewFileNavigator`: compact folders, Explorer/search file glyphs, search by path, arrow navigation, and one tree tab stop. Filtering preserves the selected diff. Escape clears the query; searching reveals matches without discarding stored collapse state. The Files toggle preserves the filter and frees the code viewport. Above 640px panel width, the list sits beside the diff; narrow panels retain a bounded list above it. |
| Review clarity | Synara keeps file navigation and the selected diff within the same review panel. | Gyro retains explicit turn, branch, working-tree, and proposed scopes. Recorded edits stay separate from a current-file comparison. Missing historical patches retain the honest unavailable state. Unknown row counts no longer crowd out filenames; the scope header still reports unavailable counts. The shared compact file-tree model was extracted from the existing recorded review, preserving the legacy hierarchy. |
| Delegated work | [ComposerSubagentStrip.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/chat/ComposerSubagentStrip.tsx) makes worker state discoverable near the composer. | Added a flat, collapsed worker summary aligned with the composer. Current-turn workers and older live workers remain visible. Approval/failure counts precede running state; stopping, completed, and cancelled remain distinct. Expansion reuses `SubagentList`, and each row opens the existing process tab. Approval controls remain in the existing transcript and process panel. |
| Session attention | [SidebarThreadRowContent.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/SidebarThreadRowContent.tsx) and [SidebarStatusTrailingGlyph.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/SidebarStatusTrailingGlyph.tsx) distinguish pending approval, working, and unread completion. | Gyro now prioritizes unresolved approvals over working and unread markers. It uses the worker transcript's existing decision reconciliation, counts distinct approvals, and filters to the latest turn. Historical imported events cannot create a live decision; new native turns in imported chats retain their live approvals. The marker remains visible beside Pin/More when selected or focused. |
| Motion and focus | [disclosureMotion.ts](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/lib/disclosureMotion.ts) and [DisclosureRegion.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/ui/DisclosureRegion.tsx) share disclosure motion and respect reduced motion. | New chevrons use Gyro's existing motion ladder and global Reduce Motion rule. The integrated matrix verifies a custom accent and `0s` computed disclosure transitions in all 12 appearance combinations. Native details handles worker disclosure semantics; tree and tab controls expose keyboard focus and selection. |
| Settings and state design | [settingsPanelStyles.ts](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/settingsPanelStyles.ts), [status-chip.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/ui/status-chip.tsx), and [PanelStateMessage.tsx](https://github.com/Emanuele-web04/synara/blob/f1b2f7c7e11867eee034d11020b043dcb53f03f9/apps/web/src/components/chat/PanelStateMessage.tsx) use consistent rows, status words, and compact empty states. | Gyro's existing grouped settings, import/updater states, recovery controls, and flat utility surfaces already meet these patterns. Their earlier 156 Settings and state checks are baseline evidence, not new checks. This pass adds explicit no-match filtering and truthful worker state summaries without adding progress estimates. |

The source comparison also checked Synara's transcript scrolling hook. Both
applications transfer scroll ownership to deliberate user gestures. Gyro keeps
its existing transcript/history controller; Synara's virtual list implementation
is not required for the file and worker presentation upgrades here.

## Rendered verification

The production React components were exercised with invented fixture data. The
initial source pass recorded 96 measured cases:

- [48 Review cases](./review-matrix.json): 2 themes × 2 densities × 3 interface
  sizes × 2 panel widths (340px and 720px) × recorded/current comparison.
- [36 worker cases](./worker-matrix.json): all 12 appearance combinations ×
  running, approval required with expanded list, and completed with expanded list.
- [12 full-app Review cases](./integrated-review-matrix.json): all appearance
  combinations, custom purple accent, and emulated Reduce Motion. Each turn's
  Review opens “This turn” and three recorded files. Disclosure transitions are 0s.

Reduce Motion was emulated by the capture harness applying Gyro's production
reduced-motion CSS. The saved records distinguish this injected-rule signal from
the browser's OS media query, which remained false. The operating system's
setting was not changed or verified.

The continuation audit recorded [48 additional approval cases](./approval-matrix.json):
command/file approvals × all 12 appearance combinations × background/selected
chat. Markers are visible with a static warning glyph, accessible approval label,
and no overlap with row actions. Selected chats show “Needs approval” and their
decision controls immediately, without expanding “Worked.” Continue is withheld
while a decision is pending. Both run layouts retain pending requests in their
visible work rail; settled turns retain normal folding behavior.

A [simulated rejection](./approval-rejection.json) cleared the sidebar marker,
restored the normal settled work header, and retained the rejected receipt. No
command or file action executed. There are 144 recorded geometry/state cases
across the two passes; the original 96 records predate the continuation edits.

No root horizontal overflow was measured. Review and worker control boundaries
stay inside their tested horizontal bounds. These are geometry checks plus
representative visual review, not a claim of individually reviewing 96 images.

Additional interaction checks covered file selection with Enter, Up/Down and
folder Left/Right, Home/End, no matching files, Escape clearing, retained filters
across hiding, worker selection into process tabs, companion Home selection,
and [terminal Home/End selection](./keyboard-terminals.json). Two simulated shells
retain exactly one terminal tab stop. No approval was granted.

An initial pointer check hit a covering Environment popover and appeared to open
the wrong Review scope. Temporary callback tracing established the correct turn
handler; closing the covering panel and keyboard activation verified the intended
entry point. Tracing was removed. The worker preview's Environment close state
was also corrected so its fixture accurately exercises the closed-rail layout.

Representative captures:

- [Review inside chat, light](./review-chat-light.jpg)
- [Wide Review, dark](./review-wide-dark.jpg)
- [Narrow unavailable-history state, light](./review-narrow-unavailable-light.jpg)
- [Worker approval and failure awareness, light](./worker-attention-light.jpg)
- [Immediate approval destination, light](./sidebar-approval-light.jpg)
- [Immediate approval destination, dark](./sidebar-approval-dark.jpg)

## Checks and limits

Typechecking, desktop production build, workbench/token smoke, architecture
boundaries, and the complete reliability suite pass. Relevant regression checks
cover shared path compaction, same-named file/directory replacement, unknown
counts, truthful worker statuses, and tab wrapping/skipping/modified keys.
The continuation additionally verifies independent chat approval state, duplicate
request reconciliation, decisions, delayed older-turn requests, legacy untagged
events, historical imports, and new native turns in imported chats. The existing
completed-run source guard was updated to retain its folding invariant while
requiring unresolved approvals to stay visible.
The build retains its existing large-chunk advisory.

[Completion audit](./completion-audit.json) validates the saved records, captures,
source comparison, and current check results. Check logs are saved in `checks/`.

This evidence proves source/build behavior and the rendered frontend with local
fixture interactions. It does not prove native Synara operation or Gyro's live
provider, Git, PTY, or approval execution. No native installation, commit, push,
or publication was performed. Unrelated dirty work remains preserved.
