# Quiet workspace sidebar — 2026-11-11

Visual target: `/Users/wytze/.codex/generated_images/01a1ca1a-7dd5-7cb1-a56e-dc666429e2cb/exec-19d130ce-ab12-4951-94ad-52e545ea75a2.png` (the approved merged concept, with the hide button next to the surface selector).

## Implementation and behavior

- Compact New session / Search / Workflows toolbar; accessible names and native tooltips on icon buttons. The existing Chat/CLI launcher remains functional.
- Hide-sidebar control directly beside the Sessions/Workspace selector (measured 4 px between controls). Existing native traffic-light reservations and window drag surface retained.
- Project disclosure chevrons, shallow tree guides, quiet selected-session fill, visible pin action and an Open project action in the section heading.
- Project pins call the existing project-settings save path, including name, folders, primary folder and nesting preference; the existing reducer, preference persistence and pinned-first sorting remain authoritative. Collapse state continues through the existing local storage path.
- Per the subsequent user correction, Project memory has no sidebar row. It remains in Edit project → Project memory, backed by `projectMemoryClient(sessionId)` → `project_memory_request`. Closing restores focus to the project control. Existing editing, stale-write checks, root scoping and permission controls remain in that backend. No new backend endpoint was needed.

## Visual QA

**final result: passed** — scoped browser/component review, not native acceptance.

Reference: 1536 × 1024 presentation containing two enlarged sidebar concepts. Compared the sidebar regions and hierarchy rather than the surrounding presentation canvas. Implementation: 1440 × 900 CSS viewport at device scale 1; detail captures use scale 2 (240 × 900 CSS sidebar → 480 × 1800 image). Additional 1024 × 900 capture uses large interface size and comfortable density.

Evidence in `docs/screenshots/2026-11-11-sidebar-implementation/`:

- `sidebar-light.png`, `sidebar-dark.png` — full application context.
- `sidebar-light-detail.png`, `sidebar-dark-detail.png` — enlarged real sidebar captures.
- `sidebar-large.png` — narrower viewport and larger interface.
- `sidebar-memory-light.png` — memory in project settings with the production component and an isolated fixture runtime.

Reviewed reference and rendered light/dark details together:

- Typography: actual Gyro font stack and support/caption tokens; consistent row baselines, truncation, semibold project labels. No new font dependency.
- Spacing: compact command row, 32 px session targets at default size, shallow nesting and section gaps; footer remains bottom anchored. Sidebar content does not horizontally overflow. The resize handle intentionally extends outside the rail and is excluded from content-overflow assertions.
- Colors: existing neutral theme tokens, muted tree lines, neutral selected fill with 6 px corners; removed the conflicting legacy white selected card in light mode. Status/provider colors retain their existing meaning.
- Assets: existing provider marks, workspace folder icons and Lucide controls. Workflow icon uses the existing library. No generated raster images are shipped as UI.
- Copy/content: actual sessions and projects populate rows; the concept's extra project/session names are sample content, not new hard-coded data. Recents renders its real empty state when appropriate.
- Keyboard/state: icon actions have accessible names; project dialog closes with Escape and restores project-control focus. Existing loading, error, conflict and save feedback stays in ProjectMemoryPanel.

No remaining P0/P1/P2 visual findings in the reviewed scope. Following the user's correction, each row owns its tree segment and the last visible chat has a curved elbow ending at its midpoint; the line never continues through the More/Less controls.

## Verification

- UI and desktop TypeScript checks passed.
- Workbench source smoke, token checks and sidebar project grouping passed. Legacy markup assertions were updated for the approved compact toolbar and accessible icon control.
- `scripts/check-sidebar-design-browser.mjs`: light/dark geometry, pin persistence, collapse persistence, New Chat, Search, Workflows, hide/restore, larger interface, absence of a sidebar memory row, and project-settings memory/focus checks.
- Existing project-memory browser regression passed save, forget, stale-write conflict, receipts and compact layouts; 13 captures in `docs/screenshots/2026-11-11-sidebar-memory-validation/`.
- `cargo test -p gyro-core project_memory --lib --offline`: 30 passed.
- Scoped whitespace/diff check passed.

Limits: browser fixtures use sample sessions and isolated memory data. No native macOS window, native folder picker, installed-app replacement, live provider action or deployment was performed. Existing unrelated working-tree changes were preserved.

## Pagination and final connector correction

The original three-chat capture did not reach the existing five-chat preview limit. More appears above that limit; Less appears after expansion. Kept the production limits (five initially, fifteen more per click) and added descriptive accessible names. Verified 24 sample chats in both themes: 5 → 20 → 24 → 5, including visibility of both controls when another batch remains. The final connector ends at the last chat's midpoint with a 6 px curve at every count. UI/desktop TypeScript, project grouping and sidebar browser checks pass. Evidence: `sidebar-more-{light,dark}-detail.png` and `sidebar-expanded-{light,dark}-detail.png` in the existing screenshot directory.
