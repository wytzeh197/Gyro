# Chat screen consolidation plan — 2026-11-10

Status: chat steps 1–5 implemented locally and verified. Wytze authorised
continuing the remaining chat work after reviewing the real-component preview
on 2026-11-10. No commit or installation was requested. Step 6 (sidebar and
settings) remains separate follow-on screen work.

See [the implementation review](chat-consolidation-review-2026-11-10.md) for
changes, validation, screenshots and limits. The final values and implementation
record below supersede the historical planning suggestions that follow them.

## Later design correction — 2026-11-10

See [the visual design-pass review](chat-design-pass-2026-11-10.md). Reply lists
now use a 16px bullet gutter, 24px numbered gutter, 4px text inset and 8px item
gap. Paragraphs/items inherit the shared 1.6 reading line height. Reply actions
have an 8px top gap. These values use the existing scaled chat spacing tokens.
The current rendered matrix is 112 states; this supersedes the earlier list
acceptance, while the consolidation evidence below remains historical.

## Final values — 2026-11-10

The real-component preview is the design reference. Preserve the existing
components, handlers, provider status meanings and split-pane mechanics.

| Token | Final value |
| --- | --- |
| `--gyro-chat-content-width` | 760px |
| `--gyro-chat-gutter` | 24px × interface scale, in every pane |
| `--gyro-chat-text-size` | 15px × interface scale |
| `--gyro-chat-text-line` | 1.6, shared by narration and finished replies |
| `--gyro-chat-small-size` | 13px × interface scale |
| `--gyro-chat-meta-size` | 12px × interface scale, the minimum text size in the column |
| `--gyro-chat-radius-card` | 12px, including user messages and code blocks |
| `--gyro-radius-composer` | Existing 18px product token |
| `--gyro-chat-turn-gap` | 24px × interface scale |
| `--gyro-chat-block-gap` | 12px × interface scale |
| `--gyro-chat-space-1/2/4` | 4/8/16px × interface scale |
| `--gyro-chat-raised` | Product `--gyro-surface`; light theme uses `--gyro-surface-soft` |
| `--gyro-chat-hairline` | Product `--gyro-border` |
| `--gyro-chat-motion-fast/normal` | 120/240ms |
| `--gyro-chat-ease` | Existing `cubic-bezier(0.22, 1, 0.36, 1)` |

Replies remain on the canvas. Actions use product ink, links/focus retain the
chosen accent, and status/diff colours retain their real semantic meanings.
Environment receives its own right-hand grid track using its existing React
component and handlers, as in the reviewed preview. This placement is recorded
separately from the mechanical CSS move.

## Implementation record

- Expanded the safety net to 100 states: original 36 plus all interface sizes,
  stacked and three-pane layouts, and forced hover/focus states. Full screenshots
  accompany computed measurements. Tour dismissal uses the actual saved tour
  record; startup preparation and finite animations settle before capture.
- Recorded development stylesheet order and a separately built production
  capture. Their original 36 computed snapshots match exactly. Artifacts live
  under `artifacts/chat-consolidation/` (local, ignored).
- Source guards now read all UI stylesheets, including nested component stylesheets. This exposed a pre-existing
  undefined `--gyro-warning` fallback in provider allowance; it now uses the
  actual theme-aware `--gyro-warn` token.

- Chat CSS now has one production owner, zero `!important`, one core token
  authority and one core block decision per role. Component styles/imports were
  folded in; empty files were removed. Shared product primitives remain shared.
- The final 100-state design baseline and contracts pass. A separately bundled
  production capture matches all 36 original matrix states. The renderer starts
  its own local server when needed and is included in smoke/CI contracts.
- Source smoke, desktop TypeScript, chat hardening, drag source/browser checks
  and companion-motion checks pass. Native WebKit layout and a real sidebar
  split gesture were checked using disposable native sessions; no provider turn
  or installed-release acceptance is claimed.
- The full-page pure-move check matched 91/100 images exactly. The remaining
  nine differed only in 3–26 header antialiasing pixels, at most 3/255 per channel.
  All computed properties matched. Exact screenshot identity is not claimed.
- The conservative final scope is 2,808 rules, including preserved uncommon
  states and auxiliary aliases. The original quarter-size estimate was not
  supported by the expanded inventory.

## Historical planning notes

The remaining sections preserve the original draft and sequencing suggestions.
Use the completed implementation record above for current status.

## Start here

Where things stand:

- Uncommitted on `Heads/v0.1.2`: `scripts/check-chat-render-snapshot.mjs`,
  `scripts/chat-render-baseline.json`, two `test:chat-render` scripts in
  `package.json`, three fixtures in `apps/desktop/src/capture-fixtures.ts`,
  and this document. Wytze has not asked for a commit yet; ask before
  committing.
- `pnpm test:chat-render` passes (36 states) with the desktop dev server on
  `127.0.0.1:1420`. It drives a headless Chromium browser over the DevTools
  protocol; set `GYRO_CAPTURE_BROWSER` if Brave is not installed.
  `GYRO_SNAPSHOT_FILTER=split` runs a subset. `--shots` saves screenshots.

Suggested order of work:

1. Commit step 1 on its own, with no product change.
2. Run `pnpm test:chat-render` before touching anything. The baseline is tied
   to the machine that recorded it. If it fails with no code change, re-record
   it and commit that alone, so later diffs mean something.
3. Do the tooling work listed under step 3 ("Before moving anything") first.
   It is independent of the design decisions, so it can run while step 2 waits
   for approval.
4. Step 2 needs Wytze's approval before step 4 starts. Step 3 does not depend
   on it.

Rules to hold to:

- In steps 3 and 4 never run `pnpm test:chat-render:update`. A difference
  means the CSS is wrong, not the baseline.
- One area per pull request. Run `pnpm test:chat-render`,
  `pnpm smoke:workbench` and the desktop typecheck on each.
- Do not rename classes, restructure `surfaces.tsx`, or change behaviour as
  part of this. Those make the snapshot useless as a safety net.

## Goal

Make the chat thread look settled: one set of decisions for width, type,
surfaces, colour and motion, written once, with nothing layered on top. The
chat thread goes first because it is the screen people compare with Claude and
ChatGPT. Sidebar and settings follow the same steps afterwards.

This is a styling consolidation. It does not change chat behaviour, the split
pane rules in `docs/chat-layout-hardening.md`, or the components in
`surfaces.tsx`.

## Where the chat styling is today

Measured from `packages/ui/src` on `Heads/v0.1.2`:

| What                                 | Today                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files with chat rules                | 14                                                                                                                                                      |
| Chat rules in `styles.css`           | 597, spread across the whole 42,000-line file                                                                                                           |
| Rules for `.gyro-composer-shell`     | 94, with 20 width and 22 radius declarations                                                                                                            |
| Rules for `.gyro-message`            | 38, with 18 width and 9 radius declarations                                                                                                             |
| Rules for `.gyro-chat-composer-dock` | 31                                                                                                                                                      |
| `--gyro-chat-content-width`          | 760px in `styles-foundation.css`, 720px × zoom in `chat-design.css`                                                                                     |
| `--gyro-composer-width`              | 800px, 800px, 720px and `var(--gyro-chat-content-width)`                                                                                                |
| Chat type sizes                      | 14px reply, 13px body, 12px work rows, 11px meta                                                                                                        |
| Load order                           | foundation → `styles.css` → 14 imports → `settings-polish` → `chat-start-polish` → `brand` → `window-chrome-density`, plus CSS imported from components |

The load order is the root problem. A rule's result depends on which later file
happens to restate it, so each fix is written as one more later rule.

## Decisions to settle first

These are proposals. They need your approval before any CSS moves, because the
rest of the plan only pays off if they then stay fixed.

| Decision     | Proposal                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Column       | One width, 760px, defined once. The user message, reply, work row, file card and composer share both edges.               |
| Reading text | 15px with 1.6 line height for replies and user messages.                                                                  |
| Small text   | 13px for work rows and cards, 12px for meta. Nothing under 12px in the chat column.                                       |
| Surfaces     | Two levels: canvas and raised. Raised is the composer, the user message and cards. Replies sit on the canvas with no box. |
| Borders      | One hairline token, used on the composer and cards only.                                                                  |
| Radius       | 12px for cards and the user message, 18px for the composer.                                                               |
| Colour       | Neutral ink for actions. User accent for links and focus. Coral only for "waiting on you". Green and red only in diffs.   |
| Spacing      | Steps of 4, 8, 12, 16 and 24px. 24px between turns, 12px inside a turn.                                                   |
| Motion       | Two durations, 120ms and 240ms, with the existing `cubic-bezier(0.22, 1, 0.36, 1)`.                                       |
| Environment  | The floating Environment panel must not overlap the column. Dock it to the right edge or move it to the side pane.        |

## Steps

### 1. Record what the chat renders today

Add a browser check that opens the existing chat fixtures and records computed
values (left and right edge, width, font size, line height, radius, border,
background) for about twelve elements: user message, reply text, work row, file
card, code block, composer, composer controls, top bar title.

Cover: empty start, active thread, streaming, two panes side by side, narrow
pane; dark and light; default and compact density.

The repo already has this pattern in `scripts/check-chat-drag-browser.mjs` and
`scripts/settings-layout-probe.mjs`. The output is a JSON snapshot plus
screenshots. It is the safety net for step 3.

**Built on 2026-11-10.** `scripts/check-chat-render-snapshot.mjs` opens the
capture harness in a headless browser and compares against
`scripts/chat-render-baseline.json`.

- Run `pnpm test:chat-render` to compare and `pnpm test:chat-render:update` to
  re-record. Both need the desktop dev server on `127.0.0.1:1420`.
  Screenshots go to `artifacts/screenshots/chat-render/` (git-ignored).
- 36 states. Start screen and active thread × 1440×900 and 900×700 × dark and
  light × interface size small, default and large (24). A live run, a reply
  with a fenced code block and a list, and two panes side by side × both
  viewports × dark and light, at the default interface size (12).
- 26 elements in the thread and 10 on the start screen, each with edges, size,
  type, colour, background, radius, border, padding, gap and shadow. The live
  run adds 7 (narration row, work rows), the code reply 5 (code block,
  paragraph, list) and the split 14 (the grid, the sash and the second pane's
  top bar, turn, reply and composer).
- The three extra states are fixtures in `apps/desktop/src/capture-fixtures.ts`
  (`edge=streaming`, `edge=code-block`, `edge=split` on the `active-chat`
  scene). The live run is a real composer send that the fake provider never
  finishes, with the clock frozen, because the app only shows a turn as
  running when its own composer sent it.
- Interface size replaced density in the matrix. Density changes nothing in
  the chat today (it only restyles the sidebar and settings); interface size
  is what drives `--gyro-ui-scale`.

Not covered yet: the three extra states at small and large interface size,
more than two panes, a short pane (stacked split), and other markdown (tables,
headings, block quotes). The baseline is also specific to the machine that
recorded it, so it is not ready for CI or `pnpm smoke:workbench` (step 5).

What the baseline already shows:

| Finding                 | Rendered today                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread column           | 684px wide at 1440×900, not the 760px token                                                                                                     |
| Start screen composer   | 760px, so the composer changes width when a thread opens                                                                                        |
| Composer radius         | 14px, not the 18px `--gyro-radius-composer` token                                                                                               |
| File card radius        | 16px, against 12px for the user message and Environment panel                                                                                   |
| Reply actions           | Start 6px left of the column edge                                                                                                               |
| Text                    | 14px reply, 13px user message, 12px work row and composer chips                                                                                 |
| Environment panel       | Covers the user message and reply at 900px wide                                                                                                 |
| Live narration vs reply | Same 14px text, but default line height while live and 23px once finished, so the text reflows when a run ends                                  |
| Work rows               | 12px, next to 14px narration                                                                                                                    |
| Code block              | 16px radius, 13px mono on a 21px line                                                                                                           |
| List in a reply         | Items start 3px right of the paragraphs                                                                                                         |
| Two panes               | 597px panes with a 537px column at 1440×900; 352px panes with a 316px column at 900×700. Turn, reply and composer share both edges in each pane |

### 2. Approve the decisions with a mockup

**Revised on 2026-11-10 after Wytze requested one-to-one fidelity.**
The original hand-built HTML mockup is superseded by a development entry that
mounts the actual Gyro React app with the existing capture IPC fixtures.
See [`mockups/chat-thread/README.md`](../../mockups/chat-thread/README.md) for
Current / Proposed comparison controls, proposed values, screenshots and QA.
Current matched the original capture harness's measured rendering. The proposal
was exercised in 19 real-component states, including scaling, approvals and
agent questions. Provider/backend data remains fixture data; native acceptance
is not established. No production chat CSS or baseline values were changed.
The snapshot driver now waits for required sidebar controls to finish hydrating
rather than clicking once after a fixed delay. Final values were subsequently authorised by Wytze’s instruction to continue; see the implementation record above.

Review the actual chat renderer in the development preview under `mockups/`
using the proposals above, dark and light. The original static-HTML suggestion
below is superseded by the real-component route. Adjust until it is right, then write the final values
into this document. After this point the values change only by editing this
document first.

**Suggested approach.**

- Build it as static HTML in `mockups/chat-thread/`, with the same content as
  the fixtures, so each mockup can sit next to the matching screenshot in
  `artifacts/screenshots/chat-render/`.
- Show four states, dark and light: a finished turn with a code block, list
  and file card; a live run; two panes; and a 900px-wide window.
- Start from the measured values in the baseline, then change only what the
  decisions table changes. That keeps the review about the decisions.
- Write every value as a CSS custom property at the top of the mockup, using
  the names step 4 will use (below). Step 4 then copies that block.
- The mockup has to settle these, which the table leaves open:
  - 15px or the current 14px for reading text.
  - One line height for narration while live and for the finished reply
    (today they differ, so text reflows when a run ends).
  - Code block radius (16px today, 12px if it follows cards).
  - List indent (items sit 3px right of paragraphs today).
  - Pane gutter in a split (30px at 597px panes, 18px at 352px today).
  - Where the reply actions start (6px left of the column today).
- When approved, add a "Final values" table to this document, one row per
  token, and treat it as the source for step 4.

Suggested token names. Keep names that exist; add the rest:

| Token                       | Holds                              |
| --------------------------- | ---------------------------------- |
| `--gyro-chat-content-width` | Column width (exists, keep)        |
| `--gyro-chat-gutter`        | Space between pane edge and column |
| `--gyro-chat-text-size`     | Reading text size                  |
| `--gyro-chat-text-line`     | Reading text line height           |
| `--gyro-chat-small-size`    | Work rows and cards                |
| `--gyro-chat-meta-size`     | Timestamps and meta                |
| `--gyro-chat-radius-card`   | User message, cards, code block    |
| `--gyro-radius-composer`    | Composer (exists, keep)            |
| `--gyro-chat-turn-gap`      | Between turns                      |
| `--gyro-chat-block-gap`     | Inside a turn                      |
| `--gyro-chat-raised`        | Raised surface colour              |
| `--gyro-chat-hairline`      | Border colour                      |

`--gyro-composer-width` should become an alias of
`--gyro-chat-content-width` in step 3 and be deleted in step 4.

### 3. Move every chat rule into one file, with no visual change

- Create `packages/ui/src/chat.css` and move all chat, composer, message and
  transcript rules into it in their current cascade order, from `styles.css`
  and from `chat-design.css`, `chat-shell-design.css`, `chat-start-polish.css`,
  `ui-upgrade.css`, `brand.css` and the other overlays.
- Put it in a CSS `@layer chat` so file order stops deciding the result.
- The step 1 snapshot must come back identical. This step is a pure move.

Then collapse it: for each selector keep only the declarations that win today,
and delete the rest. Remove `!important` as each one becomes unnecessary. The
snapshot must still be identical.

Expect `chat.css` to end well under a quarter of the current rule count.

**Suggested approach.**

_One change to the plan above: do not add `@layer chat` in this step._ Rules
in a layer lose to every rule outside a layer, whatever their specificity, and
`!important` inverts that order. Nothing in `packages/ui/src` uses layers
today, and `styles.css` has 143 `!important` declarations. Wrapping only the
chat rules would change which rule wins in many places at once. Use import
order for now: `chat.css` imported last in `styles-entry.css`. Layers can come
back in step 5, when every stylesheet can be put in one.

_Before moving anything:_

- **Add a second safety net.** The snapshot measures about 40 elements. The
  move touches about 600 rules, plus hover, focus and disabled states that the
  probes never see. Add a `--pixels` mode that compares full-page screenshots
  against a saved set. First check that two runs on an untouched tree give
  identical images. If they do not, find what moves (a caret, a spinner, a
  clock) and freeze it, as the script already does for animations.
- **Widen the states cheaply.** Run the three extra scenes at small and large
  interface size, and add a stacked split (short pane) and three panes. The
  split rules are the riskiest to move.
- **Add hover and focus states** for the composer, send button, a work row
  and a file row. Use the DevTools `CSS.forcePseudoState` call so no mouse
  position is involved.
- **Free the source-text checks.** `scripts/check-ui-tokens.mjs` reads a fixed
  list of files (`styles.css`, `chat-design.css`, `chat-file-card.css`, …) and
  `scripts/check-workbench-ui.mjs` has about 225 lines that mention chat
  selectors. Make both read all of `packages/ui/src/*.css` joined together,
  so an expectation does not care which file a rule lives in. Do this as its
  own pull request with `pnpm smoke:workbench` green before and after.
- **Record the real load order.** Six chat stylesheets are imported from
  components, not from `styles-entry.css`: `chat-run-minimal.css` and
  `chat-recovery.css` (from `chat-run-view.tsx`), `chat-file-card.css`,
  `chat-question-popup.css`, `chat-task-suggestions.css` and
  `chat-canvas.css`. Their position depends on the bundler. Read
  `document.styleSheets` in the capture harness and in a production build,
  and write the order down here. If the two differ, that is already a bug
  worth knowing about.

_The move:_

- Do it with a script (PostCSS), not by hand. Walk the stylesheets in their
  real load order, pull out every rule whose selector matches a chat prefix,
  and append it to `chat.css` in that order, keeping its `@media`,
  `@container` and `@supports` wrappers.
- Chat prefixes: `.gyro-chat-`, `.gyro-composer-`, `.gyro-message`,
  `.gyro-user-message-`, `.gyro-response`, `.gyro-run`, `.gyro-change-`,
  `.gyro-send-button`, `.gyro-context-summary-`, `.gyro-environment-`. Have
  the script print every selector it took and every `.gyro-` selector it left
  that appears inside `.gyro-chat-surface` in the captured pages, and review
  both lists once.
- A rule whose selector list mixes chat and non-chat selectors must be split
  in two, one part staying where it was.
- Moving rules to the end raises them above non-chat rules of equal
  specificity that used to come later. The script should report every
  non-chat rule that matches an element inside the chat surface and came
  after a moved rule setting the same property. Those are the only places the
  move can change the result; check each by hand.
- Bring the six component-imported files in with `@import` at the position
  recorded above, and remove the imports from the components.
- Split by area, one pull request each: transcript (message, reply, run rows,
  file card), composer, start screen and top bar, then panes and grid. Panes
  go last.

_The collapse:_

- Pass 1, mechanical and safe: where the same selector sets the same property
  twice under the same at-rule conditions, delete the one that loses (taking
  `!important` into account). No browser needed.
- Pass 2, mechanical: merge blocks with the same selector and conditions into
  one. Order between different selectors must not change.
- Pass 3, by judgment, in small pull requests: declarations that never win.
  Use the DevTools `CSS.getMatchedStylesForNode` call over all captured
  states as evidence. A declaration that wins in no captured state is only a
  candidate; check that its selector is not a state the snapshot cannot reach
  (an `is-` class, a width the matrix does not include) before deleting it.
- Remove `!important` last, one declaration at a time, each only where no
  competing declaration is left.
- Keep `--gyro-ui-scale` out of individual rules. Where a value is multiplied
  by the scale, move the multiplication into the token.

### 4. Apply the approved decisions

Change the values in one place each: the chat tokens at the top of `chat.css`.
Update the snapshot once, deliberately, and review the screenshot diff. This is
the only step where the chat is meant to look different.

**Suggested approach.**

- Apply in five commits, each with its own snapshot update and before/after
  screenshots: column and edges, type, radius and surfaces, spacing, motion.
- After each, read the snapshot diff by property. A type commit that changes
  a `left` or a `radius` has leaked.
- Add invariants to the snapshot script that do not depend on a recorded
  number. They are what "looks settled" means, and unlike the baseline they
  hold on any machine:
  - turn, reply, file card and composer share `left` and `right` in every
    state, in each pane;
  - reply actions start at the reply's `left`;
  - narration while live and the finished reply have the same font size and
    line height;
  - the composer has the same width on the start screen and in a thread;
  - no text in the column is under 12px at default interface size;
  - every radius is one of the two approved values.
    Write them now and mark the ones that fail today as expected failures. Each
    commit in this step should turn some of them green.
- The Environment panel is a behaviour change, not styling. Do it as a
  separate pull request after this step, with its own review.

### 5. Stop it drifting back

Extend `scripts/check-ui-tokens.mjs`:

- No chat selector may appear outside `chat.css`.
- In `chat.css`: no `!important`, no raw pixel font sizes, radii or colours,
  spacing only from the scale.
- Each chat token is defined exactly once.

Keep the step 1 snapshot check in `pnpm smoke:workbench`. Where
`scripts/check-workbench-ui.mjs` pins chat CSS source text, replace that pin
with the rendered value from the snapshot, so a refactor that renders the same
does not fail.

Working rule from here on: no new `*-polish.css` or `*-design.css` files. A
visual change edits the token or the one rule.

**Suggested approach.**

- Static rules go in `scripts/check-ui-tokens.mjs`, which already runs in
  `pnpm smoke:workbench` and already has a budget file. Add a budget for the
  number of chat rules and `!important` declarations that may only go down.
- The rendered check needs a running app, which `smoke:workbench` does not
  have today. Let the script start its own Vite server when nothing answers
  on the port, and run it as a separate job.
- In CI run only the invariants from step 4, not the recorded baseline. Font
  rendering differs between machines; the invariants do not. Keep the
  baseline as a local tool for refactors.
- This is the point to add CSS layers, if wanted: one `@layer` order
  statement in `styles-entry.css` covering every stylesheet, so no rule is
  left outside a layer.

### 6. Repeat for the next screen

Sidebar next, then settings (`settings-design.css` and `settings-polish.css`
are the same pattern at about 2,700 lines).

**Suggested approach.**

- Before the sidebar, split the script: the browser driver and comparison in
  one module, and one small file per screen with its scenes, probes and
  invariants (`scripts/render-snapshots/chat.mjs`, `sidebar.mjs`,
  `settings.mjs`).
- The PostCSS move script from step 3 should take the prefix list and target
  file as arguments, so it is reused as it is.
- Settings is the better second screen if time is short: it has the same
  `-design` plus `-polish` layering, and density does change it, so add
  density to its matrix.

## Order of pull requests

1. Snapshot check and baseline (no product change).
2. Mockup and final values in this document.
3. Move chat rules into `chat.css` (identical snapshot).
4. Collapse duplicates and remove `!important` (identical snapshot).
5. Apply the decisions (snapshot updated once).
6. Lint rules and replaced source-text pins.

Steps 3 and 4 are the large ones. They can be split by area — transcript,
composer, start screen, top bar — as long as each part keeps the snapshot
identical.

## Risks

- **Split and short panes.** The hardening rules for tiled panes are behaviour,
  not polish. They move as they are and the snapshot covers two-pane and narrow
  states.
- **UI scale and density.** 570 declarations multiply by `--gyro-ui-scale`.
  The snapshot must include compact density or step 4 will break it unnoticed.
- **CSS imported from components.** `chat-run-view.tsx` and others import their
  own stylesheets, so their order depends on the bundler. Step 3 must bring
  these into `chat.css` too.
- **Source-text checks.** `check-workbench-ui.mjs` has 421 expectations, some
  matching CSS text. Some will fail on a pure move and need converting first.
- **The real window.** Fixtures run in a browser. Native vibrancy and the Tauri
  window need one manual pass after step 5.
- **Layers.** See the note under step 3: a layer around only the chat rules
  would reorder the cascade against every unlayered rule.
- **What the probes do not see.** Popovers, menus, the question popup, plan
  mode, subagent rows, recovery cards and error states have chat styling and
  no fixture state. Either add states for them before their rules move, or
  move those files whole without collapsing them.
- **Production order.** The harness runs on the Vite dev server. Stylesheet
  order can differ in a production build. Check one built app after step 3.

## Done when

- Every chat rule lives in `chat.css`, with no `!important`.
- Each chat token has one definition.
- The five elements of a turn share the same left and right edge in every
  captured state.
- The lint rules and the snapshot check run in `pnpm smoke:workbench`.

## Open questions

1. Is 760px the column, or do you want the wider 800px the composer uses now?
2. Should the user message keep a filled bubble, or become plain right-aligned
   text on the canvas?
3. Where does the Environment panel go: docked right, or into the side pane?
4. Does the user-chosen accent stay on the send button, or is send always ink?

Suggested answers, for Wytze to confirm in step 2:

1. **760px.** The token and the start screen already say 760px; the 684px
   thread column looks accidental. Step 3 should find out which rule produces
   it before step 4 changes it.
2. **Keep the filled bubble.** With replies sitting on the canvas with no box,
   the bubble is the only thing that marks where a turn starts.
3. **Into the side pane.** A panel floating over the column cannot be fixed
   with spacing at 900px wide, and the top bar already has a side pane
   button. This is the one item that changes behaviour, so it gets its own
   pull request.
4. **Send is always ink.** It follows the colour decision: accent for links
   and focus only. An accent send button competes with the coral "waiting on
   you" state.
