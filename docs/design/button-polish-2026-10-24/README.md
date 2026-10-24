# Button placement polish — 2026-10-24

Scope: the composer action row (mic, attach, send), the most-used button row in
the product. Goal: one placement rule for the row instead of eight competing
declarations, so controls line up at every UI scale.

## What was wrong

`audit-buttons.mjs` (this folder) reads the stylesheets and reports the declared
geometry per button family. Before this pass the send button had **five**
different sizes and the tool buttons three, across both stylesheets:

| Context | Tool button (before) | Send button (before) | Result |
| --- | --- | --- | --- |
| Base composer | 28 × 30 (`width: 28px` + `height: 30px`) | 31 × 31 | Tools squashed to a rectangle, send 1px taller |
| Chat start / hero | 30 × 30 | 29 × 29 | Send 1px smaller than its neighbours |
| Composer dock | 30 × 30 (28px wide in one rule) | 32 × 32, then 29 × 29 | Send up to 4px larger than the tools |
| Empty / thread surface | inherited 30 × 30 | 28 × 28 (`chat-design.css`, higher specificity) | Send 2px smaller than the tools |

Two separate problems came out of that:

1. **Rhythm.** The mic/attach/send buttons are `border-radius: 50%`/`999px`
   circles, but they were not all square and not all equal. A 28×30 control with
   a circular radius renders as a squashed ellipse next to a 31×31 circle.
2. **Scale.** Every one of those sizes was raw `px`. The rest of the composer
   (chips, gaps, padding) multiplies by `var(--gyro-ui-scale, 1)`, so at any UI
   scale other than 100% the buttons drifted out of alignment with the row they
   sit in.

## The rule

> Every control in the composer action row uses one size token,
> `--gyro-composer-action-size`, so the row stays square and aligned at every
> UI scale.

Defined once in the compact density token block:

```css
--gyro-composer-action-size: calc(30px * var(--gyro-ui-scale, 1));
```

Applied to `.gyro-composer-tool` and `.gyro-send-button` in every context.
Context-specific colour, radius, shadow and motion stay untouched — only
geometry moved to the token.

### Changes

- `packages/ui/src/styles.css`
  - added `--gyro-composer-action-size`
  - `.gyro-composer-tool, .gyro-send-button`: `30px` → token
  - `.gyro-composer-tool`: `width: 28px` → token (2 occurrences, restores square)
  - `.gyro-chat-start .gyro-composer-tool`: `width: 30px` → token
  - `.gyro-chat-start .gyro-send-button`: `29px` → token
  - `.gyro-chat-composer-dock .gyro-composer-tool`: `30px` → token
  - `.gyro-chat-composer-dock .gyro-send-button`: `32px` → token (2 occurrences)
  - `.gyro-chat-composer-dock .gyro-send-button`: `29px` → token
  - removed `height/width: 31px` from the base `.gyro-send-button` (it now
    inherits the row token instead of overstating Send by 1px)
- `packages/ui/src/chat-design.css`
  - empty/thread `.gyro-send-button`: four `calc(28px * scale)` declarations →
    the token, so it matches the tools in the same row

Rounding is deliberately unchanged: the send button stays circular, which is the
standing direction in `docs/design/squared-ui/README.md`.

## Verification

- `node docs/design/button-polish-2026-10-24/audit-buttons.mjs`
  - unscaled px geometry on button selectors: **10 before → 0 after**
  - every composer tool/send rule now declares the token
- `node scripts/check-workbench-ui.mjs`: 9 failures before the change, 9 after,
  **identical lists** (all pre-existing: model catalogue, plan events, companion
  dock, composer model/effort controls).
- `node scripts/check-ui-tokens.mjs`: fails identically on a pristine `HEAD`
  worktree — a decorative gradient at `styles.css:31137` that is not on the
  content allowlist. Pre-existing, unrelated to this change.

## What this pass did not cover

No browser or Playwright runtime is installed in this environment, so this pass
was measured statically, not visually. Still open for a rendered pass:

- **Chip vs button height in the base composer.** `.gyro-composer-chip` is
  min-height 26px in the base row, 30px under `.gyro-chat-start`, 28px in the
  dock. Text pills may intentionally be shorter than the round icon buttons, but
  the three different numbers are worth a decision.
- **Chip corner radii.** `999px` (base), `var(--gyro-radius-sm)` (line 11787),
  `var(--gyro-radius-md)` (chat start), `999px` (dock). Same row, four corners.
- **Icon sizes inside the row.** Mic and send both use `size={17}`; the stop
  square uses 10. Verify optically once a renderer is available.

Next step is a screenshot pass over `chat`, `chat-start`, `chat-composer-dock`
in dark and light, then the chip radius/height decisions above.
