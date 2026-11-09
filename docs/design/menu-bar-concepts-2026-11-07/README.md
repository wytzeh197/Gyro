# Gyro menu bar concept exploration

Generated 2026-11-07 with built-in image_gen from the supplied screenshot and the actual Gyro mark. These are design proposals with fictional sample tasks, not implemented behavior.

## Three directions, four scenarios

| Scenario | 1 — Native compact | 2 — Activity glance | 3 — Next action |
| --- | --- | --- | --- |
| Idle | Small identity/status header and menu commands | Explicit empty state and Open Gyro | Clear primary Open Gyro button |
| Working | Dense list, elapsed time and stop controls | Task list with visible detail and model metadata | One focused task, other work summarized |
| Needs you | Command context and inline approval | Approval leads; other running task stays visible | Review request is the primary action |
| Finished | Recent result as a navigation row | Success state with View result action | One finished task and prominent View result |

Recommendation: combine direction 1's restrained identity/status row, direction 2's task list, and direction 3's attention hierarchy. Keep the gear in the header. Direction 1's generated extra Settings row makes idle taller than the current screenshot; remove that row in a refinement. The existing idle design is already compact, so increased height must earn its space with useful context.

## Source grounding

Inspected:
- `apps/desktop/src/MenuBarPopover.tsx`: idle, working, waiting/approval, recent completion/failure, task navigation, stop and settings actions.
- `apps/desktop/src/menu-bar-state.ts`: source data, waiting-first ordering, job details and outcomes.
- `apps/desktop/src/menu-bar.css`: actual menu-specific palette, type, spacing and shape tokens.
- `apps/desktop/src-tauri/src/menu_bar.rs`: 372px card width and native geometry.
- `packages/ui/src/styles-foundation.css`: actual Gyro palette, typography and geometry.
- Supplied native screenshot and `packages/ui/src/assets/gyro-logo-mark.png`.

The current source already keeps waiting jobs first and restricts file-change requests to opening the chat for review. Preserve that distinction. Inline command approval is an existing path; wording such as “Approve once” is a proposal and requires checking the provider's actual semantics before implementation. Additional model labels and job details shown on these proposals are present in the source data, but literal sample values are fictional.

## Visual review

| Check | Result |
| --- | --- |
| Product identity and dark utility surface | Pass at concept level; original screenshot/logo attached to all three generations |
| Hierarchy and readable grouping | Pass at concept level; each direction has a distinct structure |
| Semantic color use | Pass visually: neutral idle, blue working, amber permission, green completion |
| Idle, populated, waiting and complete | Shown across all three boards |
| Error and loading states | Not rendered in this exploration; existing source includes failure and in-progress actions |
| Exact token fidelity and dimensions | Unverified; these are raster concepts, not measurements or production components |
| One primary action | Direction 3 strongest; direction 1 completion has competing navigation rows to refine |
| Logo fidelity | Recognizable in raster output; use the original source asset in implementation |
| Keyboard, focus, screen reader, native interactions | Unverified; static concepts only |
| App code changes | None |

The images intentionally do not claim verified test success, completion percentages, costs, or estimated finish times.

## Files

- [01-native-compact.png](01-native-compact.png)
- [02-activity-glance.png](02-activity-glance.png)
- [03-next-action.png](03-next-action.png)
- [prompts.md](prompts.md): exact generation prompts

## Selected direction and refinement — 2026-11-07

Wytze selected option 1, Native compact. This selection supersedes the earlier recommendation to combine directions; the refinement preserves option 1's structure.

- [Refined concept board](01-native-compact-refined.png)
- [Exact refinement prompt](prompt-native-compact-refined.md)

Settings moves to the header, the idle state becomes two rows, command approval retains its context with an “Approve” label, and the finished task itself links to the result. The duplicate Settings and View result rows are removed.

Visual review: all four requested scenarios remain visible; hierarchy, native utility character, semantic colors and requested copy are preserved at concept level. Raster sizing/token accuracy, keyboard/focus behavior, error/loading states, and native interaction remain unverified. No application code was changed.

## Approval notification and Reply in chat — 2026-11-07

Wytze requested these two views in the selected option 1 style. Created with built-in image_gen using the refined board and actual Gyro mark as attached image references.

- [Approval notification](04-approval-notification.png): native notification concept using the current title “Gyro has a question” and provider-command notification copy from `apps/desktop/src-tauri/src/desktop_notifications.rs`. Clicking is intended to open the relevant chat; the image has no inline approval buttons. OS rendering, desktop wallpaper, clock and tray decoration are illustrative and not a native capture or implementation specification.
- [Reply in chat](05-reply-in-chat.png): proposed additional menu bar state with the task, provider, full sample question, one “Reply in chat” action, other running activity, and Open Gyro. The action is intended to navigate to the original chat and question. This is not verified existing question routing.
- [Exact generation prompts](prompts-approval-and-reply.md)

Visual review: pass at concept level for selected direction, readable question/message text, amber attention meaning, blue background-activity meaning, header settings placement and single primary reply action. Notification copy matches the inspected code. Exact OS appearance, pixel/token fidelity, live data, keyboard/focus, screen-reader behavior and navigation/delivery are unverified. Empty/loading/error variants are outside this two-view exploration. No application code changed.

## Implemented in the local checkout — 2026-11-07

The earlier “no application code changed” statements describe the image exploration only. Wytze subsequently authorized implementation of option 1, its approval notification, and Reply in chat.

- [Implemented states](implementation/implementation-preview.png), captured from the production menu component.
- [Full implementation review](implementation/design-qa.md), including comparisons, interaction evidence and validation limits.
- Interactive development fixture: `http://127.0.0.1:1420/menu-bar-fixture.html`.

The menu uses a compact identity/status/settings header, two-line task rows, elapsed times, stop controls, full command previews, inline supported approvals, file-change review navigation, result rows, and an unanswered-question preview. Questions use the same current-turn reconciliation as chat/sidebar attention and clear after an answer. Reply navigation also reopens a dismissed question and focuses it in its original chat. Native approval notifications retain their existing privacy and permission checks; notification clicks explicitly select the workspace destination before opening the chat.

Native window sizing matches the new menu geometry and supports scrollable overflow. Source/type checks, menu/question checks, the isolated production build and scoped Rust tests pass. The broad workbench check also passes on the clean proposed commit; the full dirty worktree has separate layout edits outside this change. No live-provider approval, actual macOS notification delivery, or installed-app acceptance was claimed; no release, push, deployment or app replacement occurred.

## Per-chat AI logos — Image Gen preview, 2026-11-07

Wytze requested a visual preview of the AI logo on each chat so its provider is immediately identifiable.

- [Provider-logo concept](06-provider-logos.png)
- [Exact generation prompt](prompt-provider-logos.md)

This single revision retains option 1 and shows leading Claude, OpenAI and Gemini marks beside task title/activity. Provider identity remains visible in working, approval, reply and finished states; the Gyro header keeps its own mark. Provider names in subtitles explain unfamiliar marks. All task data is illustrative.

Grounding: current menu tokens, `menu-bar-model-provider.ts`, the actual `ProviderLogo` component in `workspace-sidebar.tsx`, and an existing provider-settings image used only to ground logo appearance. Future implementation should reuse that product component and job provider/model identity, retaining its fallback for providers without a known mark.

Concept review: pass for recognizable per-chat identity, consistent leading alignment, readable task hierarchy and distinct status/action controls. Brand hues identify providers; header status glyphs/text identify state. Exact raster logo geometry, final sizing, focus and interactions remain unverified in this image. This follow-up changes design artifacts only; no application source was edited.

## Provider logos approved and implemented — 2026-11-07

Following approval of the preview and the request to commit, per-chat provider logos were implemented using the existing `ProviderLogo` component. Running, approval, reply and completed rows retain their AI identity; provider/model names also appear in subtitles and accessible chat labels. Recent outcomes preserve identity across the native snapshot boundary.

- [Implemented provider logos](implementation/provider-logos/implementation-preview.png)
- [Provider-logo review and validation](implementation/provider-logos/design-qa.md)

The historical preview-only statements above describe the earlier image exploration. The latest section records the implemented change.
