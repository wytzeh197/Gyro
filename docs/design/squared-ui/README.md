# Squared supporting UI — 2 October 2026

Gyro keeps its graphite/porcelain surfaces, blue accent, system typography,
spacing, and layout. Supporting navigation, controls, cards, dialogs, and
menus now use a restrained 3/4/6/8/10px corner ladder, previously
5/7/9/12/14px. Existing literal utility corners use the same shared tokens.
The separate menu-bar window and first-paint navigation follow this treatment.

The main composer retains its 18px corners (and existing 16px compact-pane
variant), conversation bubbles retain their 16px finish, and workspace seams
retain their existing geometry. Circular switches, status marks, send buttons,
and semantic pills remain round. Menu geometry now follows the menu radius
rather than borrowing the composer radius; inset color swatches clamp at zero.

## Verification

- Desktop production build passed.
- Workbench smoke and UI token checks passed; the existing medium-radius
  assertion was updated to the new 6px value. No failure baseline was relaxed.
- `git diff --check` passed.
- Real application fixture inspected in dark mode at 1280 × 720 with compact
  density, and light mode at 860 × 620 with comfortable density.
- Rendered radii verified: sidebar rows 4px, navigation switch/search/segmented
  controls 6px, environment 8px, branch menu 10px, composer 18px, message 16px.
- Branch menu opened and dismissed with Escape. No horizontal page overflow
  in the compact welcome view.

These captures use invented development fixture data. They establish rendered
appearance and local navigation, not native macOS hosting or live providers.
The installed desktop application has not been rebuilt or replaced.

## Captures

- [Dark conversation](chat-dark.jpg)
- [Dark settings](settings-dark.jpg)
- [Compact light settings](settings-light-compact.jpg)
- [Compact light welcome](welcome-light-compact.jpg)
- [Compact light branch menu](branch-menu-light-compact.jpg)
- [Compact light automations](automations-light-compact.jpg)
