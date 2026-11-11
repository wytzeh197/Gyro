# Composer sizing and popup polish — 2026-11-11

The input now owns its sizing: a scaled 56px minimum and 160px maximum at
default size, with 16px insets. Autosizing reads the computed CSS limits so
interface size changes apply to multiline drafts too. Legacy textarea rules
that overrode this were removed. Toolbar controls use a shared 32px target
and 13px label size; the existing bottom position and context row are retained.

Add, Approval, Model, Effort, Project, Workspace and Branch menus clear the
whole composer. Project, Workspace and Branch align with their own triggers.
Utility menus share surface, inset, row typography and corner treatment.
The model picker is 320 by 384px at default sizing, with a scrolling list;
Approval is 320px wide and Add is 256px wide. Available pane space constrains
all menus. The open workspace trigger no longer displays its native tooltip.

## Review and evidence

- Tokens/components: pass. Existing Gyro tokens and controls; no new palette.
- Sizing and containment: pass. 48-state renderer matrix, light/dark and
  small/default/large interfaces. Separate popup probes checked all seven
  menus at desktop and narrow widths and four toolbar menus in split panes.
- Stress layout: pass. Four toolbar menus remained above the composer and
  inside a 900×620 split fixture with large interface sizing.
- Input behavior: pass. Actual browser input typed ten lines, verified 160px
  growth and bottom docking, opened Add/Branch, dismissed with Escape, and
  sent a fixture message. Checked both provider-ready and disconnected states
  at 1440px and 900px. Disconnected Send stayed disabled.
- Hierarchy/status: pass. Provider/approval/model choices still use their
  original handlers and current state; warning meaning is preserved.
- Source checks: desktop TypeScript, UI tokens, chat CSS ownership/rule budget,
  workbench smoke and diff whitespace checks passed.
- Native, live provider, error/recovery, dictation recording and screen-reader
  behavior: not exercised in this pass. The installed app was not rebuilt.

Screenshots are real production components with local fixture data:

[Model and composer detail](../screenshots/2026-11-11-composer-polish/model-detail-1440-light.png)
· [Approval](../screenshots/2026-11-11-composer-polish/approval-1440-light.png)
· [Add, dark](../screenshots/2026-11-11-composer-polish/add-900-dark.png)
· [Large interface, narrow split](../screenshots/2026-11-11-composer-polish/model-900-dark-split.png)

## Input-to-toolbar spacing correction

The rendered gap was 2px: two older high-specificity rules overrode the
new toolbar padding. Removed those competing padding declarations. The
toolbar now uses the existing scaled 12px chat block gap above its controls,
8px horizontal insets and no extra bottom padding. Browser measurements
confirmed 12px at desktop/narrow default sizing and 13.8px at large sizing
in a split pane. Token/style checks and workbench smoke passed.

[Corrected spacing](../screenshots/2026-11-11-composer-spacing/after-1440-start.png)

Candidate project rule, proposed only: Give the detached composer toolbar
one authoritative, scaled gap from its input. This keeps its separation
consistent across new chats, threads and split panes.

## Popup anchor correction

Wytze corrected the bottom-row menus as too high. Add, Approval, Model and
Effort now use their own control as the vertical anchor, with an 8px gap,
rather than clearing the full composer. This supersedes the earlier
whole-composer placement decision above. Pane containment and height
clamping remain active. Twelve browser cases passed: four menus in desktop
light, narrow dark and split panes; each stayed within its pane and within
10px above its trigger. Desktop TypeScript, source smoke and diff checks
passed. Installed/native behavior was not rechecked.

[Corrected model picker](../screenshots/2026-11-11-composer-popup-position/model-detail-1440-light.png)

Candidate project rule, proposed only: Anchor bottom-row composer menus
to the button that opens them. The short gap makes their relationship
clear and avoids lifting small menus unnecessarily high.
