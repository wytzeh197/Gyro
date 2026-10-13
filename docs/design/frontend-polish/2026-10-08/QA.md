# Gyro frontend polish — completion QA

Completed on 2026-10-08. The pass preserves Gyro's navigation, panel placement,
provider identity, graphite/porcelain surfaces, and blue palette while tightening
chrome, text hierarchy, control sizing, and state presentation across the frontend.
It builds on the shared dirty checkout; unrelated work is preserved.

The reference was Synara's [published app presentation](https://www.trysynara.com/hero-app-light-1152w.webp)
and [site](https://www.trysynara.com/). Its useful cues were restrained weights,
quiet surfaces, compact controls, and readable conversation and utilities.
This is a qualitative polish pass, not a claim of identical design or verified
Synara native behavior.

## Changes

- Navigation actions retain a 24px target at Small size, with a scaling title
  gutter. Long Settings destinations stay on one line with ellipsis and a
  tooltip. The narrow Settings search field uses a readable short placeholder.
- Global search opens with an opaque panel; removed the parent opacity entrance
  that exposed the page beneath it. Headers, results, keycaps, and controls share
  the existing type and density hierarchy.
- Automations uses the shared title scale, flatter grouped rows, quieter icons,
  and smaller empty-state spacing. Creation keeps its list content from shrinking
  into a clipped label; the setup panel scrolls with its footer reachable.
- Settings segmented controls retain their target size. Storage paths stack
  beneath their description when the content column is narrow. Language-service
  details use readable shared small-text tokens.
- Empty editor chrome no longer suggests an active document or shows unusable
  Save/Split actions. Monaco's existing switch to inline diff follows interface
  scale, keeping enlarged text readable in narrow code panes.
- Review recovery actions use the shared secondary-button treatment. Companion
  Files uses the same file-identity icons as Explorer. Canvas empty-state copy
  has a proper inset; artifact tables and actions use the shared readable text size.
- A stale selected terminal ID now falls back to the first listed pane. Filtering
  still excludes model-owned background panes. Closing a question or plan
  decision returns keyboard focus to the revealed composer without taking focus
  away from another control.
- The first-paint shell matches current sidebar breakpoints, hero measure,
  composer corners, and system type. Startup recovery fills the window and uses
  consistent text and reload controls. Its real component is shared with a
  development preview; the boot and surface-boundary guards still pass.

## Coverage and evidence

Screenshots render the real React components with invented sessions, files,
provider status, captures, import jobs, and command output. They establish frontend
appearance and local interactions. They do not establish native provider, Git,
PTY, browser-host, updater, or transcript-import behavior.

| Required area                                                    | Result and representative evidence                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions, welcome, chat, environment                             | Both themes and all size/density combinations; desktop views through 1728×1117. [Welcome](./core-light-comfortable-large-welcome.jpg), [desktop chat](./final-chat-dark-1728.jpg)                                                                                                                                                                     |
| Composer, model, effort, context and approval mode menus         | Inspected at 860×620 with Large text; choices, keyboard traversal, and dismissal work. Approval policy was unchanged. [Model picker](./model-picker-860-large-light.jpg), [effort](./effort-xhigh-860-large-light.jpg)                                                                                                                                |
| Global search and confirmation overlays                          | Opaque results, arrow-key selection, Escape, focus return; reset dialog traps Tab among its actions. [Search](./search-860-large-light.jpg), [confirmation](./reset-confirmation-860-large-light.jpg)                                                                                                                                                 |
| Workspace Explorer, Search, Source Control, editor and Run/Test  | Empty and populated content, search hit/no-hit, selected working-tree diff, narrow inline diff, and Run/Test empty state. [Desktop diff](./final-workspace-diff-light.jpg), [narrow diff](./diff-responsive-860-large-after.jpg)                                                                                                                      |
| Companion Review, Terminal, Browser, Files, Canvas and Side chat | Empty and populated representative states, narrow overlays, selected tabs, unavailable historical patch, real xterm rendering, canonical file icons, and Canvas document/table/code/interactive preview. [Review fallback](./final-review-fallback-dark.jpg), [terminal](./terminal-visible-after.jpg), [Canvas](./canvas-ui-preview-light-after.jpg) |
| Split chats and live/completed work                              | Independent scroll areas, narrow composers, three-column layout, grouped/failed activity disclosure, final response ordering. [Split chat](./split-chat-completed-dark.jpg), [narrow split](./split-chat-narrow-light.jpg)                                                                                                                            |
| Workers and approvals                                            | Running, failed, completed, measured/approximate/unavailable usage, focused process and waiting approval; approval controls fit at 860px. No approval was granted. [Worker approval](./worker-approval-860-light.jpg)                                                                                                                                 |
| Questions, goals and plans                                       | Long choices and own-answer field, arrow keys and Escape, composer focus return, goal editor, blocked plan steps, document view, and implement decision in both themes. [Question](./question-dock-860-large-light.jpg), [plan decision](./plan-decision-light.jpg)                                                                                   |
| Automations                                                      | Index and creation in both themes and all appearance combinations; repeat menu opens and dismisses; setup footer remains reachable. No automation was created. [Setup](./core-light-comfortable-large-automation-setup.jpg)                                                                                                                           |
| All 13 Settings pages                                            | General, Appearance, Keyboard, Usage Limits, Providers, CLI Profiles, Permissions, Editor & Search, Tools & Contributions, Import projects, Updates, Advanced, Help. All pages reviewed in light/dark with representative appearance extremes. [Storage rows](./settings-final-dark-advanced.jpg)                                                     |
| Import states                                                    | Scanned projects and selected chats, missing-folder candidate, loading, scanning, failed, running and completed states. No real transcript was read or imported. [Selection](./import-selected-light.jpg), [failure](./import-error-dark.jpg)                                                                                                         |
| Updater and startup states                                       | Current, checking, available, downloading, ready, installing, failed, development, unavailable; loading shell plus startup/render recovery in both themes. No update was invoked. [Updater failure](./updates-failed-light.jpg), [recovery](./first-paint-startup-error-dark.jpg)                                                                     |
| Custom accent and Reduce Motion                                  | Purple accent throughout the 12 appearance combinations. Preview emulates the real Reduce Motion hook input and applies the production CSS media-query rules; the OS preference is unchanged. [Evidence](./reduced-motion.json), [view](./reduced-motion-appearance-light.jpg)                                                                        |

## Measured matrix

[Completion audit](./completion-audit.json) validates 250 recorded layout cases
at 860×620, with no root horizontal overflow:

- [156 Settings cases](./settings-matrix.json): 13 pages × 2 themes × 2 densities
  × 3 interface sizes, custom accent and reduced motion.
- [60 core cases](./core-matrix.json): welcome, chat, Automations, setup, Workspace
  × the same 12 appearance combinations, with regular motion.
- [10 import states](./import-states.json), [18 updater states](./updater-states.json),
  and [6 first-paint states](./first-paint-states.json), covering both themes.

The 216 core/Settings cases also measured visible main-control boundaries; none
extended horizontally beyond the viewport. These geometry checks complement
individual page review and representative screenshots; they are not a claim that
every saved image was individually inspected.

All 12 reduced-motion combinations report the active state in Settings, compute
transitions to `0s`, and finish entry animations in `0.01ms`. The original preview
parameter was corrected after discovering that a stored preference cannot activate
the OS media query. Welcome captures were also corrected to wait for real app
controls rather than accidentally measuring the first-paint shell.

## Verification

- `CI=1 pnpm typecheck`: passed for UI and desktop.
- `CI=1 pnpm --filter @gyro-dev/desktop build`: passed. Existing large-chunk
  warning remains; development fixtures are not production entries.
- `CI=1 pnpm smoke:workbench`: passed at 860×620, 1280×720, 1440×900, 1728×1117,
  including UI tokens.
- `CI=1 pnpm test:reliability`: passed, including the guard registry (78 reachable
  guards), startup recovery, terminal selection, Review scope, questions,
  companion isolation, architecture, code intelligence and language services.
  Its temporary localhost test server required the sandbox's network exception.
- Formatting checks for new components and targeted guard files passed;
  `git diff --check` passed.

Rendered requirements above are complete. Source changes remain local and
reviewable. The pass does not include a native installation or publication.
