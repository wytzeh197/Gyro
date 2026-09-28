# Gyro polish — 26 September 2026

Polish the existing desktop interface without moving panels, navigation, or core controls. The graphite/porcelain palette, system type, blue accent, provider identity, and density preferences are preserved.

Git baseline: `db0225289670f4b6375dc97504a27ac2c34b0468` on `release/v0.1.0-alpha.49.7`. Fetch/prune and fast-forward-only pull completed; checkout and upstream were already equal. Changes are local and uncommitted. The installed application has not been rebuilt or replaced.

## Implemented

1. **Persistent selection.** Sidebar selection uses the existing blue accent, distinct from neutral hover. Automation filters and workspace settings scopes have a clear selected state. Following review, the composer retains its neutral border while typing or using its controls.
2. **Controls and empty states.** Compact provider dropdown text fits its existing 28px height. Source-control sync buttons use Gyro controls instead of browser defaults. Empty review content fits inside the existing tool drawer. An empty browser panel explains where to enter a URL and disables its unavailable external-open action.
3. **Search correctness across frontend and backend.** Ripgrep JSON preserves unusual filenames and exact regular-expression submatches. UTF-8 byte offsets become UTF-16 editor columns, including non-ASCII characters. Literal fallback returns every match. Previews retain correct highlights after trimming indentation or shortening long lines. Root-level files no longer show a spurious directory label.
4. **Diff editor lifecycle.** A reproduced Monaco error occurred when text models were disposed while still attached to a diff widget. The adapter now detaches models before releasing them, retaining the existing model-preservation options. Close, refresh, and diff-to-file transitions were exercised after the fix.
5. **Repeatable development captures.** The development-only harness supports an explicit state reset, asynchronous IPC responses, current session context/workspace data, populated diff responses, correct terminal IDs, successful mock fetch status, and query-dependent search ranges. It is not a production entry point.

## Coverage

These are screenshots of the real React application using invented development fixture data. They demonstrate rendering and local interactions, not live provider connections, real GitHub status, native browser hosting, or terminal process execution.

| Surface | Evidence and outcome |
| --- | --- |
| Shell / welcome / conversation | Dark and light chat, active rows, composer focus, environment surface, welcome state |
| Context menus / dialogs | Context menu, global search, reset confirmation opened then cancelled |
| Workspace explorer / editor | Populated light editor; dark search result selected the correct line and text |
| Source control / review | Populated side-by-side diff, styled sync button, compact empty review drawer |
| Terminal / browser | Populated fixture terminal; browser idle guidance and disabled action |
| Automations | Existing list and setup inspected; selected list filter strengthened |
| Settings | Appearance, providers, usage, permissions, keyboard, CLI profiles, editor/search, tools, updates, advanced and help inspected |
| Run and Test / workspace AI | Existing empty run catalog and populated AI composer checked without moving controls |
| Narrow desktop width | Chat and providers checked at 860 × 620; existing responsive layout retained |

## Validation

- Workspace `pnpm check` and full `pnpm test:reliability` passed.
- Workbench smoke checks, UI token checks and architecture ceilings passed; no ceilings were raised.
- Five focused Rust tests passed: three workspace-search tests, including real ripgrep execution, and two existing model-search tests.
- Final desktop typecheck and source-control review checks passed after the editor lifecycle fix.
- Changed CSS, capture fixture, search files and managed editor passed formatting; `git diff --check` passed.
- Browser verification covered exact search navigation, diff rendering/refresh/close, theme switching, focus, menus, and compact-width rendering. Closing a populated diff produced no new console errors after the lifecycle fix. Diff-to-file navigation no longer produced the model-disposal error; separate Monaco cancellation messages were still observed during view-state restoration.

Native macOS integration and live-provider flows were not exercised. This pass does not establish exhaustive coverage of every possible state or account configuration.

## Screenshots

Default captures are 1280 × 720; files containing `compact` are 860 × 620.

Chat captures predate the follow-up removal of the blue composer focus border.

- [Advanced dark](advanced-dark.png)
- [Appearance dark](appearance-dark.png)
- [Automations dark](automations-dark.png)
- [Browser dark](browser-dark.png)
- [Chat dark](chat-dark.png)
- [Chat light compact](chat-light-compact.png)
- [Chat light](chat-light.png)
- [Cli profiles dark](cli-profiles-dark.png)
- [Confirmation dark](confirmation-dark.png)
- [Context menu light](context-menu-light.png)
- [Editor light](editor-light.png)
- [Editor settings dark](editor-settings-dark.png)
- [Help dark](help-dark.png)
- [Keyboard dark](keyboard-dark.png)
- [Permissions dark](permissions-dark.png)
- [Providers dark](providers-dark.png)
- [Providers light compact](providers-light-compact.png)
- [Providers light](providers-light.png)
- [Review empty dark](review-empty-dark.png)
- [Run test dark](run-test-dark.png)
- [Search dialog dark](search-dialog-dark.png)
- [Source control dark](source-control-dark.png)
- [Terminal dark](terminal-dark.png)
- [Tools dark](tools-dark.png)
- [Updates dark](updates-dark.png)
- [Usage dark](usage-dark.png)
- [Welcome dark](welcome-dark.png)
- [Workspace ai dark](workspace-ai-dark.png)
- [Workspace search dark](workspace-search-dark.png)
