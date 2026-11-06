# Settings → Updates

The Updates page is one status card that answers "am I current, and what happens
next", then the preferences that change how Gyro looks for releases, then the
release notes. Everything on it resolves through tokens the rest of Settings
already uses.

## What was wrong

| Problem                                                                                                                                                                                                      | Evidence in the previous build                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| The status pill was a private dialect. `SettingsStatus` (dot + label, `is-good/warning/critical/neutral`) already existed for provider rows; Updates shipped a rival `.gyro-update-pill` with its own tones. | `SettingsStatus` in `packages/ui/src/surfaces.tsx`; the removed `.gyro-update-pill` rules in `packages/ui/src/styles.css` |
| Colour ignored Appearance → Colors. The card's primary action and progress bar used `--gyro-update-blue: #356fd6`, a fixed blue, so a user accent never reached them.                                        | removed `.gyro-update-action` and its `background: var(--gyro-update-blue)`                                               |
| The pill's accent label was mixed toward white on a 20% tint — the class of failure `scripts/check-ui-tokens.mjs` already calls out for the dark status ramp.                                                | removed `color-mix(… var(--gyro-update-blue) 58%, white 42%)`                                                             |
| Elevation was ad hoc: `box-shadow: 0 10px 28px color-mix(in srgb, #000 8%, transparent)` on two cards.                                                                                                       | now `0 10px 28px var(--gyro-premium-shadow-soft)`                                                                         |
| The spec strip always rendered three cells, so "Latest" said `Unknown` and a build with no reported version said `Unknown` twice.                                                                            | the strip is now a `<dl>` built from `updateFacts()`                                                                      |
| Release notes were a third card style (own border, own shadow, own padding) rather than the same card as the status block.                                                                                   | `.gyro-update-notes` now only adds gap and padding on `.gyro-update-card`                                                 |

## The card

```
┌ mark ─ Gyro 0.1.0-alpha.49.3  [Public Alpha]  ● Update available ─ actions ┐
│       ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  (only while downloading)                     │
├──────────────┬──────────────┬───────────────┬────────────────────────────┤
│ Installed    │ Latest       │ Download size │ Last checked               │
└──────────────┴──────────────┴───────────────┴────────────────────────────┘
```

- The **summary sentence** under the heading exists only where it says
  something the pill does not. `available` has none: the dot already reads
  "Update available", the primary button already names the build, and Gyro has
  not downloaded anything yet, so it must not claim a signature it has not
  checked. `updateStatusSummary()` therefore returns `undefined` for
  `available`, and the paragraph is not rendered.

- The **actions** column holds the same primary step the sidebar button offers
  (`Update to <version>`, `Restart to update`, `Try update again`) and only in
  statuses where a click moves the update forward, plus `Check for updates`,
  which is disabled while a check or an install is running.
- The **facts row** renders only what the updater actually reported:
  `updateFacts()` in `packages/ui/src/update-state.ts` returns the installed
  version (omitted for `"unknown"`/`"development"`), the latest version (or
  "Up to date" once a check confirmed it, otherwise nothing), the download size,
  and the last completed check. No cell is ever a placeholder, and the heading
  drops the version rather than printing "Gyro Unknown".
- Both bands sit on their own middle line. `.gyro-update-card-head` is
  `align-items: center`, so the mark tile, the copy (heading, optional summary,
  progress) and the actions share one centre instead of hugging the top, and
  `.gyro-update-facts > div` is `align-content: center`, so a cell whose value
  wraps to two lines keeps its label level with its single-line neighbours.
- A `<span aria-live="polite" class="gyro-sr-only">` carries
  `updateAnnouncement()`: the outcome in words, silent for `checking`,
  `development`, and an unavailable updater.

## Colour, motion, elevation

- The status dot and the mark's tint share one level: `updateStatusLevel()`
  returns `good` (current) / `info` (available, downloading, ready, installing,
  checking) / `critical` (failed) / `neutral` (development, unavailable). The
  card publishes it as `data-level`, and the dot is `<SettingsStatus>` — the
  same primitive the provider rows use, with `is-info` drawn in
  `var(--gyro-accent)`.
- The primary action is `.gyro-primary-button`, so it uses
  `--gyro-primary-bg` / `--gyro-primary-text` / `--gyro-primary-hover` and
  follows Appearance → Colors. The mark tile and progress fill use
  `--gyro-accent-soft`, `--gyro-accent-strong`, and `--gyro-accent`.
- Shadows use `--gyro-premium-shadow-soft`; corners use `--gyro-radius-md` and
  `--gyro-radius-xl` instead of a one-off `10px`.
- Rotation of the refresh icon stops under `prefers-reduced-motion: reduce`,
  and the progress fill loses its width transition there.

## Discoverability

While `shouldShowSidebarUpdate()` is true, the Settings sidebar marks the
Updates row with `.gyro-settings-page-flag` (an accent dot; the row grows a
third grid track only when the flag is present) plus a screen-reader "Update
available" label, so an update waiting on a restart is visible without opening
the page.

## States covered by the preview harness

`apps/desktop/src/settings-preview.tsx` renders the real `SettingsSurface` for
every updater state, and takes `?scene=updates&state=…&theme=…&accent=…`:

| `state`       | what it shows                                            |
| ------------- | -------------------------------------------------------- |
| `current`     | good level, "Up to date", facts without a size           |
| `checking`    | accent level, checking sentence, action disabled         |
| `available`   | accent level, primary "Update to <next>", notes card     |
| `downloading` | accent level, measured 64% progress, no primary          |
| `ready`       | accent level, "Restart to update", "Downloaded" fact     |
| `installing`  | accent level, check disabled while installing            |
| `failed`      | critical level, the error as the sentence, retry primary |
| `development` | neutral level, "Updates disabled", no primary            |
| `unavailable` | neutral level, no updater state at all: no facts row     |

The harness now also applies `--gyro-user-main` / `--gyro-user-secondary` at the
root, the way `apps/desktop/src/App.tsx` does, so a preview can show which
surfaces follow the accent.

## Verification

- `pnpm smoke:workbench` (workbench smoke + UI tokens) passes, including new
  assertions for the status level ramp, `updateFacts()`, `updateAnnouncement()`,
  the card's markup, and the sidebar flag.
- `pnpm --filter @gyro-dev/ui exec tsc -p tsconfig.json --noEmit` and the same
  for `@gyro-dev/desktop` pass; Prettier reports the touched files unchanged.
- Rendered light and dark states of the real `SettingsSurface` in the
  development-only `settings-preview.html` harness, at 977×897:
  `docs/screenshots/updates-settings/updates-available-light.png`,
  `…-accent-orange.png` (the same card with Appearance → Colors set to
  `#c2410c`: mark, dot, and primary button all move), `…-downloading-light.png`,
  `…-failed-light.png`, `…-unavailable-dark.png`.

### Limits

- The preview is in-memory: it does not prove a signed download, an install, or
  that a real click reaches the updater.
- The sidebar row flag was asserted in the smoke check and reviewed in source,
  not rendered: the harness shows the Settings surface, not the shell sidebar,
  and a development build is never in a status that raises the flag.
- `--gyro-update-blue` and `.gyro-update-primary` still belong to the sidebar
  update button and the workspace-preparation popover. The Updates card no
  longer uses either; re-tokenizing those is a separate change.
