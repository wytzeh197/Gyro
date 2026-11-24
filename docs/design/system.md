# Gyro design system

The single spec for Gyro's visual system: tokens, elevation, type, density,
z-order, motion and primitives. It grows phase by phase as the design-system
plan lands. When a rule here and a stylesheet disagree, the stylesheet is the
bug.

Gyro keeps its own identity: Geist and Geist Mono, cobalt accent `#8fa8ff`,
attention `#ff7150`, warm dark neutrals and porcelain light. What it borrows
from Synara (MIT) is discipline, not appearance: one small token set, one
primitive per job, flat controls, and depth from a handful of elevation tokens.
Earlier feature-level comparison work lives in
[synara-source-upgrade](./synara-source-upgrade/2026-10-08/QA.md).

## Principles

1. **Flat controls.** Buttons, inputs, rows and chips have no shadow. Depth
   belongs to floating surfaces only, through the four elevation tokens.
2. **One primitive per job.** A menu is `Menu`, a dialog is `Dialog`, an empty
   state is `Empty`. A new surface composes primitives; it does not restyle a
   copy of one.
3. **Tokens, not literals.** Colour, radius, weight, tracking, z-order, shadow
   and duration come from `--gyro-*` tokens. Hex and `rgb()` appear only in
   token definitions.
4. **Zero-specificity base.** Primitive selectors are wrapped in `:where()` so
   a surface can adjust them without `!important`.
5. **Both themes, every density.** A change is finished when it reads correctly
   in light and dark at compact, comfortable and spacious density and every
   interface size.
6. **Motion respects the user.** Every animation has a reduced-motion fallback
   honouring `data-reduce-motion` and `prefers-reduced-motion`.

## Tokens

Source: `packages/ui/src/styles-foundation.css`, with appearance overrides in
`appearance.css` and faces in `brand.css`.

### Ladders

| Family    | Tokens                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Radius    | `xs` 4 · `sm` 6 · `md` 8 · `lg` 12 · `xl` 16 · `composer` 18 · `pill` 999 (px)                                                               |
| Type size | `tiny` 10 · `caption` 11 · `micro` 12 · `support` 13 · `body`/`chrome` 14 · `lead` 16 · `heading`/`display-size` 22 (px × `--gyro-ui-scale`) |
| Spacing   | `compact` 4 · `standard` 8 · `group` 10 · `card` 12 · `panel` 16 · `section` 20 (px)                                                         |
| Faces     | `--gyro-font-sans`, `--gyro-font-display` (Geist), `--gyro-font-mono` (Geist Mono)                                                           |

### Semantic set (Phase 1)

Phase 1 defines these with static values, mostly aliases of the existing
palette, so the Phase 5 theme engine changes where values come from, never
their names. New code uses these; the `--gyro-premium-*` names are deprecated
aliases kept only while `chat.css` still reads them.

- **Elevation:** exactly four. Controls get none.

  | Token                    | Value                                     | Used by                            |
  | ------------------------ | ----------------------------------------- | ---------------------------------- |
  | `--gyro-shadow-composer` | `0 4px 18px -6px var(--gyro-shadow-lift)` | the composer                       |
  | `--gyro-shadow-popover`  | `0 12px 28px var(--gyro-shadow-soft)`     | menus, popovers, selects, tooltips |
  | `--gyro-shadow-toast`    | `0 8px 24px var(--gyro-shadow-soft)`      | toasts and floating notices        |
  | `--gyro-shadow-dialog`   | `0 16px 48px var(--gyro-shadow-strong)`   | dialogs and alert dialogs          |

  Shadow colours: `--gyro-shadow-strong` (.4 dark, .12 light), `-soft`
  (.24 / .05) and `-lift` (.3 / .08).

- **Surfaces:** `--gyro-surface-under` (app background), `--gyro-panel`
  (cards), `--gyro-elevated` (floating), `--gyro-control` with `-hover` and
  `-active`, `--gyro-user-message` (user bubble and code-block surface).
- **Borders:** `--gyro-border-light`, `--gyro-border`, `--gyro-border-heavy`,
  `--gyro-border-focus`, `--gyro-hairline` (0.5px, seams and dividers only).
- **Text and icon tiers:** `--gyro-text-primary`, `-secondary`, `-tertiary`,
  `-quaternary` (disabled, placeholder; tertiary at 64%), with `--gyro-icon-*`
  twins. The legacy `--gyro-text`, `--gyro-muted` and `--gyro-faint` stay as
  aliases until Phase 4.
- **Z-scale:** `--gyro-z-base` 1, `-sticky` 20, `-popover` 140, `-dialog`
  (`--gyro-layer-dialog`), `-toast` 11500, `-tour` 12000. No new literal
  `z-index`; the remaining literals move onto the scale in Phase 4.
- **Weights:** `--gyro-weight-regular` 400, `-medium` 500, `-semibold` 600,
  `-bold` 700.
- **Tracking:** `--gyro-tracking-tight` -0.02em (display), `-normal` 0,
  `-caps` 0.04em (small uppercase labels).
- **Type roles:** these map onto the existing ladder rather than new factors,
  so nothing reflows in Phase 1.

  | Role                       | Maps to                    |
  | -------------------------- | -------------------------- |
  | `--gyro-text-ui`           | `--gyro-font-body` (14)    |
  | `--gyro-text-ui-lg`        | 15 × scale                 |
  | `--gyro-text-ui-sm`        | `--gyro-font-support` (13) |
  | `--gyro-text-ui-xs`        | `--gyro-font-micro` (12)   |
  | `--gyro-text-ui-2xs`       | `--gyro-font-caption` (11) |
  | `--gyro-text-timestamp`    | `--gyro-font-tiny` (10)    |
  | `--gyro-text-chat`         | `--gyro-chat-text-size`    |
  | `--gyro-text-chat-sm`      | `--gyro-chat-small-size`   |
  | `--gyro-text-chat-code`    | chat × .95                 |
  | `--gyro-text-chat-display` | chat × 1.6                 |

## Density

To be specified in Phase 6. Density (compact .85, comfortable 1, spacious
1.15) scales spacing and `--gyro-row-height`; interface size
(`--gyro-ui-scale`) stays the zoom-like control. The two do not overlap.

## Primitives

Primitives live in `packages/ui/src/primitives/` and are exported from
`@gyro-dev/ui`. They are built on `@base-ui/react` (headless behaviour:
focus, dismissal, positioning, ARIA), styled in `primitives/primitives.css`
with BEM-style classes (`gyro-btn`, `gyro-btn--ghost`, `gyro-btn--sm`), and
rendered in every state by `apps/desktop/primitives-gallery.html`.

Rules for primitive CSS:

- Every selector is wrapped in `:where()` so specificity is zero. Anything
  that outranks a primitive is a legacy global rule to lower or remove. The
  `button { color: inherit }` rule was one: it is now `:where(button)`.
- Controls are flat: `box-shadow: none`. Only surfaces use the four
  `--gyro-shadow-*` tokens.
- Focus is `outline: 2px solid var(--gyro-border-focus)`.
- No hex, rgb or `var(--gyro-x, literal)` fallbacks; sizes that have no token
  are custom properties on the primitive.

Button variants: `default`, `secondary`, `destructive`, `prominent`, `outline`,
`primary-outline`, `destructive-outline`, `ghost`, `chrome`, `subtle`, `link`.
Sizes: `chip`, `xs`, `sm`, `md`, `lg`, `xl`. `IconButton` needs a `label`.

Verification: `node scripts/check-primitives-browser.mjs` (or
`run-canvas-preview-browser.mjs --primitives`) checks light and dark at 390 and
1280px: layout, no overflow, flat controls, button label contrast, focus
outline, and menu, select, dialog, alert dialog and toast behaviour.

| Primitive                                                                       | Replaces                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Button, IconButton                                                              | 37 `*-button` / `*-btn` classes                  |
| Menu, ContextMenu, Popover, Select                                              | 31 `*-menu` / `*-popover` / `*-dropdown` classes |
| Dialog, AlertDialog                                                             | per-surface dialog shells                        |
| Empty                                                                           | 39 `*-empty` classes                             |
| Spinner, LiveStatusSpinner, Skeleton                                            | duplicated spin keyframes and spinning icons     |
| Toast, StatusChip                                                               | banners and notice pills                         |
| Tooltip, Kbd, ShortcutPill                                                      | title tooltips and ad-hoc key hints              |
| Input, Textarea, SearchField, Switch, Checkbox, Radio, SegmentedControl, Slider | `quiet-controls.css`, `native-controls.css`      |
| Tabs, Disclosure, ScrollArea, Separator                                         | per-surface variants                             |

## Motion

Today: `--gyro-motion-fast` 80ms, `--gyro-motion` 130ms and
`--gyro-motion-slow` 180ms, each multiplied by `--gyro-motion-factor`.

Phase 9 (`motion.css`) adds durations 140, 160, 200, 220 and 280ms; standard, out (`cubic-bezier(.22,1,.36,1)`) and spring
(`cubic-bezier(.34,1.56,.64,1)`) eases; all multiplied by
`--gyro-motion-factor`.

## Guardrails

`scripts/check-ui-tokens.mjs` (part of `pnpm smoke:workbench:source`) counts
every Gyro stylesheet and fails when any metric rises above
`scripts/ui-token-budget.json`. Budgets only fall: after a cleanup lands,
lower them with `node scripts/check-ui-tokens.mjs --update-budget` on a tree
that contains only that cleanup.

`scripts/check-workbench-ui.mjs` asserts against CSS and TSX source. A phase
that breaks an assertion updates it in the same commit. Assertions are
replaced, never deleted. Where a family of selectors becomes a primitive, the
assertion checks that the primitive is used.

Distinct-value metrics ignore a bare `var(--gyro-*)`, so "0" below means every
declaration of that property uses a token.

## Metrics

Baseline measured at `da87473e` (HEAD of `v0.2.0`, 2026-11-22) without the
uncommitted app-preview work.

| Metric                       | What it counts                                   | Baseline |         Target | Phase |
| ---------------------------- | ------------------------------------------------ | -------: | -------------: | ----- |
| `important`                  | `!important` uses                                |      298 |           ≤ 20 | 4     |
| `lightThemeSelectors`        | `[data-theme="light"]` overrides                 |      281 | engine-derived | 5     |
| `hexLiterals`                | hex values outside token definitions             |      113 |              0 | 4     |
| `rgbLiterals`                | `rgb()`/`rgba()` outside token definitions       |      117 |              0 | 4     |
| `tokenLiteralFallbacks`      | `var(--gyro-x, literal)`                         |       19 |              0 | 1     |
| `pillRadiusLiterals`         | literal `999px` radii                            |        0 |              0 | —     |
| `fontSizeValues`             | distinct literal font sizes                      |        9 |              0 | 1, 6  |
| `fontWeightValues`           | distinct literal weights                         |        6 |              0 | 1     |
| `radiusValues`               | distinct literal radii                           |       26 |            ≤ 4 | 4     |
| `zIndexValues`               | distinct literal z-indexes                       |       45 |              0 | 1, 4  |
| `letterSpacingValues`        | distinct literal tracking                        |       25 |              0 | 1     |
| `boxShadowValues`            | distinct literal shadows                         |      212 |           ≤ 12 | 4     |
| `backdropFilterDeclarations` | `backdrop-filter` uses                           |       21 |            ≤ 3 | 7     |
| `keyframes`                  | `@keyframes` blocks                              |       53 |              — | 3, 9  |
| `buttonClasses`              | `gyro-*-button` / `-btn` classes                 |       37 |            ≤ 4 | 3     |
| `menuClasses`                | `gyro-*-menu` / `-popover` / `-dropdown` classes |       31 |            ≤ 4 | 3     |
| `emptyStateClasses`          | `gyro-*-empty` classes                           |       39 |            ≤ 2 | 3     |
| `navigationRowPxHeights`     | literal px heights in `navigation-design.css`    |       20 |              0 | 6     |

Each phase appends its measured row to the history below.

### History

| Phase          | Commit      | Shadows | Hex | `!important` | z-index | Weights | Buttons | Menus | Empty |
| -------------- | ----------- | ------: | --: | -----------: | ------: | ------: | ------: | ----: | ----: |
| 0 (baseline)   | `da87473e`  |     212 | 113 |          298 |      45 |       6 |      37 |    31 |    39 |
| 1 (tokens)     | uncommitted |     211 | 113 |          298 |      43 |       6 |      37 |    31 |    39 |
| 2 (primitives) | uncommitted |     211 | 113 |          298 |      43 |       6 |      38 |    31 |    39 |

Phase 2 adds the primitives without migrating call sites, so counts only move
where the primitives themselves add to them: `buttonClasses` +1 (37 → 38) and
`keyframes` +3 (53 → 56). Both budgets were raised deliberately and fall again
in Phase 3 as call sites move over.

## Third-party credit

Logic ported from Synara (MIT, © 2026 T3 Tools Inc., Emanuele Di Pietro)
carries a header credit in each ported file and is listed in
`THIRD_PARTY_NOTICES.md`.
