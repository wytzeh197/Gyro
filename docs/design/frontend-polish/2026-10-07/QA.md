# Gyro frontend polish — 2026-10-07

Goal: polish the whole desktop frontend to the visual quality of Synara's
published app presentation while preserving Gyro's navigation, panel placement,
provider identity, graphite/porcelain surfaces, and blue accent.

This is the preliminary 2026-10-07 snapshot. The resumed pass is complete;
see the [2026-10-08 completion QA](../2026-10-08/QA.md) for the final changes,
rendered coverage, appearance matrix, and passing verification.

## Reference and criteria

Inspected the live [Synara site](https://www.trysynara.com/) and its
[published app image](https://www.trysynara.com/hero-app-light-1152w.webp).
The useful quality cues are quiet chrome, restrained weights, flat content,
compact controls, readable activity, and clear boundaries between conversation
and utilities. Synara's native runtime was not tested.

Completion requires a coherent result across Sessions, welcome and populated
chat, composer/context/model controls, companion tools, Workspace Explorer,
Search, Source Control and diffs, terminal/browser, Automations, all Settings
pages, menus, questions, approvals, and confirmation overlays. Validate light
and dark, compact and comfortable density, small/default/large interface size,
custom accent, reduced motion, and 860×620 through desktop viewports.

## Changes in this pass

- Navigation action targets have a 24px floor. Their reserved title gutter
  follows interface scale, preventing action overlap at Large size.
- Global search arrives as an opaque panel. Its original opacity entrance
  exposed page text behind the search results. Result headings, row height,
  keycaps, and header follow the shared hierarchy and density tokens.
- The empty editor tab no longer claims active-document selection.
- Automations uses the shared page-title scale, flatter grouped rows, quieter
  icons, a shorter empty state, and density-aware search/filter controls.
- Settings segmented controls retain a 24px target at Small interface size.
- The first-paint shell now shares the running app's sidebar breakpoints,
  720px hero measure, 22px heading, 18px composer corners, and system type.
  It exposes its loading status to accessibility. Root-error type also uses
  the system stack.
- The existing token guard now includes navigation and scheduled-work CSS.
- Extracted the existing `WorkspaceHeader` into its own module, preserving its
  markup and public export, to bring `surfaces.tsx` below its architecture ceiling.

No routes, provider semantics, pane ownership, native browser bounds, or
terminal/editor font preferences were changed by this pass.

## Preliminary rendered evidence on 2026-10-07

The capture harness renders the real React frontend with invented sessions,
files, provider status, and command responses. These views prove frontend
appearance, not real provider, Git, terminal, import, or native behavior.

| Surface                                                 | Evidence                                                  | Remaining                                                             |
| ------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Welcome and sidebar                                     | Inspected at 1280×720 dark                                | Light and size/density matrix                                         |
| Populated chat, composer, environment rail              | Inspected at 1280×720 dark                                | Recheck scaled navigation targets, menus, split panes                 |
| Automations index                                       | Inspected after edits; [capture](./automations-dark.jpg)  | Light, enlarged/narrow, search/filter/creation interactions           |
| Settings General and Providers                          | Inspected at 1280×720 dark                                | Other pages and full appearance matrix                                |
| Workspace Explorer                                      | Inspected at 1280×720 dark                                | Recheck quiet empty tab and theme/size matrix                         |
| Source Control and selected Monaco diff                 | Inspected at 1280×720 dark                                | Light, narrow window and action states                                |
| Global search                                           | Inspected before edits; identified entrance bleed-through | Verify edited entrance, keyboard traversal, focus return, light theme |
| Companion tools, workers, questions, approvals, dialogs | Source available                                          | Rendered QA still required                                            |
| First-paint and root-error treatment                    | Source and startup checks                                 | Rendered QA still required                                            |

The Mac locked during this preliminary verification. The Mac was available on
2026-10-08, and the resumed pass finished the coverage listed in the completion QA.

## Repeatable harness controls

Use `/capture.html?scene=welcome&reset=1&theme=dark&density=compact&size=default`.
The `size` parameter accepts `small`, `default`, or `large`; `accent=7352cb`
sets a custom accent; `motion=reduced` requests reduced motion. These only
affect the development harness's browser preferences. Production preferences
are not written. The `companion-layout` scene uses the same appearance inputs.

## Verification

- `pnpm typecheck`: passed after the first-paint changes and header extraction.
- `pnpm --filter @gyro-dev/desktop build`: passed after the first-paint
  changes and header extraction. Existing large-bundle warning remains.
- `node scripts/check-ui-tokens.mjs`: passed after adding both CSS modules.
- `node scripts/check-startup-performance.mjs`: passed after first-paint edits.
- `git diff --check`: passed.
- `pnpm smoke:workbench`: initially passed twice, then briefly failed its
  first-send/provider-persistence assertion in the changing shared checkout.
  The latest smoke run passes. No provider execution code was changed by this pass.
- `node scripts/check-architecture-boundaries.mjs`: passed after extracting
  the existing header. The ceiling was preserved at 29,926 lines.
- `pnpm test:reliability`: reached the guard registry, which found existing
  guards without complete registration. Added the file-link guard to the runner
  and registered file links, backend responsiveness, imported-session order,
  subagents, and subagent browsers as behavioral checks. The registry now passes.
  The final full reliability suite passed, including code intelligence and
  language-server checks after the registry.
- Prettier checks for the new modules and first-paint files: passed.

These were intermediate checks. The completion QA records the broader rendered
verification and final passing gates; this preliminary snapshot alone was not
completion evidence.
