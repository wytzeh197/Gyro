# How Claude (Opus) designs: a field manual for other agents

*Compiled 2026-11-06 from the design guidance installed on this machine and loaded into Claude's sessions.*

---

## 0. Read this first

**What this document is.** A plain description of where Claude's design quality comes from, written so another agent (or a person setting one up) can reproduce it.

**One honest caveat.** Claude can't inspect its own weights. "Design skill" isn't one module you can open. It comes from three layers working together:

| Layer | What it is | Where it lives | Can another agent copy it? |
|---|---|---|---|
| 1. Model priors | Broad knowledge of typography, color theory, layout, web standards and design history from training | Inside the model | Partly. Most strong models have some of this. The written layers below are what turn it into consistent output. |
| 2. Factory guidance | Instructions Anthropic ships that load when Claude does design work: the `frontend-design` skill, the artifact design guides, the inline-widget (visualize) guide, the `dataviz` skill | Plugin and skill files, plus tool and server instructions | **Yes.** This is most of what's portable, and most of this report. |
| 3. Project guidance | The user's own design system and checklists (`agent-design-system`, `/new-screen`, `/review-screen`, `/capture-rule`) | `~/.claude/skills/` | Yes. It overrides layer 2 wherever the two disagree. |

**The short answer to "what makes it good":** a strong model by itself already knows plenty of design theory. What makes the output good is that the written guidance adds five things:

1. **A plan before any code.** Tokens, type and layout are decided and reviewed before anything is built.
2. **A named list of AI defaults to avoid.** The model is told exactly what "generic" looks like, so it can recognize its own first instinct and reject it.
3. **Restraint as a rule.** Boldness goes in one place, and decoration has to justify itself.
4. **Ideas taken from the subject.** Colors, type and layout come from the thing being designed, not from a house style.
5. **Looking at the result.** Claude renders the page, screenshots it, critiques it against the plan and fixes what it finds.

The rest of this document unpacks each of these into rules you can follow.

---

## 1. Mindset: who Claude pretends to be

The `frontend-design` skill casts Claude as **the design lead at a small studio**. The client has already turned down proposals that felt templated and is paying for a point of view.

What that persona changes:

- **Opinions are required.** "Clean and modern" is not a direction. Each project gets a specific aesthetic stance: what it's like, what it refuses to be, where it takes a risk.
- **The default is suspect.** Whatever comes to mind first for "a landing page for X" is treated as the thing to avoid, because it's also what every other model produces.
- **Taste, then execution.** A maximalist direction needs elaborate execution, and a minimal one needs precise spacing and type. Elegance means carrying out the chosen idea well. It doesn't mean minimalism.

The persona changes with the medium (see §8). For **utilitarian** work (dashboards, tools, internal UI) the stance becomes *"a senior product designer who makes it obvious and fast."* For **editorial** work (landing pages, games, things people share) it's *"a studio with a distinctive voice."*

---

## 2. The process: five steps, in order

This is the most portable part. Any agent can follow it.

### Step 1: Ground the design in the subject

Before choosing anything visual, ask: **what does this thing look like in its own world?**

- A tide-table app → nautical charts, almanacs, the blue-greys of open water.
- A bakery → flour, kraft paper, hand-lettered chalkboards.
- A developer CLI tool → terminal output, man pages, plain text.

Colors, type and layout motifs come from that world. The hero (the first screen) should open with **the most characteristic thing in it**: a real headline, image, live demo or interaction, not a generic tagline over a gradient.

### Step 2: Write a token plan (pass 1)

Before writing code, write a short plan:

```
PALETTE   4–6 named colors, each with a hex value and a job
          e.g. Harbor #1F3A4D (text) · Foam #F2F5F4 (bg) · Buoy #E4572E (one accent)
TYPE      display face + body face + (optional) mono, each with a role and why it fits
          a type scale (e.g. 14 / 16 / 20 / 28 / 44) and the weights you'll use
LAYOUT    an ASCII wireframe of the first screen and the overall flow
PRINCIPLES 3–5 one-line rules for this specific project
          e.g. "Data is the decoration," "One accent, only on actions"
```

### Step 3: Review the plan against the defaults (pass 2)

Go through the plan line by line and ask: **"Would I produce this for any similar page?"** If yes, revise that line before building. Check it against the anti-pattern list in §5. Fix it quietly: no "I initially chose X but…" narration to the user.

This is the step that does the most work. Most generic AI design survives because nobody checked the plan against what generic looks like.

### Step 4: Build from the plan

- Put every token in one `:root` block and refer to it everywhere. No stray hex values in components.
- Build the full thing. It should be **complete at rest**: every important piece of content visible without scrolling into view, clicking, or waiting for an animation.
- Pin library versions when loading anything from a CDN.

### Step 5: Look at it and critique

- Render it and take a screenshot. Look at the actual pixels, not the code.
- Check it against the plan. Did the palette survive? Is the hierarchy obvious? Is anything clipped, overlapping, or too long to read comfortably?
- Fix it, then do **one** final rendered check before publishing. One verification pass, not endless polishing.

---

## 3. Craft rules: typography, color, layout, motion

### Typography

The guidance treats Robert Bringhurst's *The Elements of Typographic Style* as the standard.

- **Type sets the personality.** Pair the display and body faces on purpose. Avoid the families you'd reach for on any project. The type treatment should be one of the memorable parts of the design, not a neutral container.
- **A clear type scale** with deliberate weights, widths and letter-spacing. Fewer sizes, each used consistently.
- **Line length:** body text under ~80 characters, ideally around **65** (`max-width: 65ch`).
- **`text-wrap: balance`** on headings, so a single word doesn't wrap onto a line of its own.
- **`font-variant-numeric: tabular-nums`** wherever numbers line up in columns or change live.
- **Sentence case** by default for headings and UI labels.
- **Real typographic characters:** curly quotes, true dashes, proper ellipses.

### Color

- **4–6 named colors, and each one has a job.** If a color has no job, remove it.
- **One accent, spent in one place.** If the accent clashes with the background, shift it toward a neighboring hue or desaturate it. Don't swap it for something safer.
- **Semantic, not decorative.** Status colors (green, amber, red, blue) mean success, warning, error and running. Never use them as decoration.
- **Dark mode is designed, not inverted.** Give it its own palette, check contrast in both modes, and use a real dark surface rather than pure black (see §5 for the specific trap).
- **Contrast:** body text must meet WCAG AA in both themes.

### Layout

- **The squint test:** blur your eyes. There should be one clear focal point, then a clear second level.
- **Consistent spacing scale** (4px or 8px base). No one-off values like 13px or 10px.
- **Generous but purposeful whitespace.** Space shows grouping. It isn't filler.
- **Summary before detail** on anything with data: the headline number or conclusion first, the breakdown after.
- **Show state through form.** Show a disabled, done or pending state through shape, weight and position, not color alone.
- **Mobile is a real layout,** not a squashed desktop. Check a ~375px viewport.

### Motion

- **One orchestrated moment beats scattered effects.** A page-load sequence, a meaningful hover, or ambient atmosphere: pick the one the direction calls for.
- **Less is often more.** Extra animation makes a design look more AI-generated.
- **Respect `prefers-reduced-motion`.**
- Nothing important should be hidden behind an animation that has to finish first (this is part of being "complete at rest").

---

## 4. Restraint: the quality floor

The guidance comes back to this again and again, and it's probably the biggest gap between Claude's output and typical AI design.

- **Spend boldness in one place.** One bold typographic move, one striking color, or one unusual layout. Not all three. Keep everything around it quiet.
- **Chanel's rule:** before you leave the house, look in the mirror and take one accessory off. Before shipping, find the one decorative element that does the least work and remove it.
- **Every element has to earn its place.** If removing something doesn't make the page worse, it shouldn't be there.
- **Show real content.** Use real copy, real data and real states, not lorem ipsum or invented testimonials.
- **Quality floor (never ship below this):** responsive, accessible contrast, visible focus states, no overflow or clipping, dark mode handled, loading, empty and error states present where data can be missing.

---

## 5. The anti-pattern catalogue: what "AI-generated" looks like

This is the most distinctive part of the guidance. It names the specific looks that models fall back on, so Claude can catch itself. **If your plan matches one of these, revise it.**

### Default palettes and looks

| Cluster | What it looks like | Why it's a tell |
|---|---|---|
| **The "warm editorial" default** | Cream background (~`#F4F1EA`), a serif display face, a terracotta accent (~`#D97757`) | It's become the house style of AI-made "tasteful" pages |
| **The "hacker" default** | Near-black background, acid or neon green accent, monospace everywhere | Every dev-tool page an AI makes looks like this |
| **The broadsheet** | Newspaper-style columns, hairline rules everywhere, a masthead | Borrowed seriousness that has nothing to do with the subject |
| **The SaaS card kit** | A grid of identical rounded cards, each with `box-shadow: 0 x x rgba(0,0,0,.1)`, an icon, a title and two lines of text | The most generic layout on the web |
| **Purple-to-blue gradients**\* | Hero gradients, gradient text, glowing blobs | The 2020s startup cliché |

### Template chrome (small habits that add up)

- **ALL-CAPS eyebrow labels** above every heading ("FEATURES", "HOW IT WORKS").
- **"A · B · C" meta strings:** dot-separated tags used as decoration.
- **"WORD — fragment" labels**, such as "Speed — built for scale."
- **`#0B0B0B` or similar instead of real black**, picked by reflex rather than as a choice.
- **Monospace for data labels** just to look technical.
- **Arrows (→) appended to every link** and button.
- **A single accent-colored word in the headline**, e.g. "Build *faster* with AI."
- **Fake numbering (01 / 02 / 03)** on things that aren't actually sequential.
- **Emoji as icons** in feature lists.\*

\* *Not named in the installed guidance. Added from general design practice because they're common tells.*

### Writing that sounds generated

- Mannered devices: "It's not X, it's Y," triplets used for rhythm ("Fast. Simple. Yours."), rhetorical questions as headings.
- Filler: "seamlessly," "effortlessly," "unlock," "elevate," "supercharge."
- Pseudo-profound one-liners in place of information.

**How to use this list:** it isn't a ban on those choices. A tide app could legitimately use a serif. The rule is that **any choice on this list has to be justified by the subject**, not by habit.

---

## 6. Words are design too

From `frontend-design` and the Claude Design System content rules:

- **Name things from the user's point of view** ("Your projects," not "Project entities").
- **Active voice, verb-first actions:** "Save draft," "Publish," "Invite teammate."
- **Consistent action names across states:** a button that says *Publish* leads to *Published*, not *Live* or *Posted*.
- **Errors say what happened and what to do next:** "Couldn't save. You're offline — we'll retry when you reconnect." Not "An error occurred."
- **Empty states give direction:** what goes here, and the one action that fills it.
- **Cut "please," "successfully," "simply," "just."** "Saved," not "Successfully saved!"
- **Status text must match the real state.** An approval card that still says "Needs approval" after approval destroys trust. This matters even more in agent products.
- **Sentence case** everywhere in the UI.

---

## 7. Two modes: utilitarian vs editorial

The first decision for any page is which mode it's in. The two have different rules.

| | **Utilitarian** (tools, dashboards, reports, internal UI) | **Editorial** (landing pages, games, things people share) |
|---|---|---|
| Goal | Obvious and fast | Memorable, with a point of view |
| Type | One well-made sans, maybe a mono; hierarchy through size and weight | A deliberate display and body pairing; the type is part of the identity |
| Color | Mostly neutral; one accent for the primary action; status colors only for status | A palette drawn from the subject; one bold move |
| Layout | Dense but calm; summary first; scannable | Hero states the thesis; pacing and rhythm matter |
| Motion | Almost none; functional transitions only | One orchestrated moment |
| Risk | None. Predictability is a feature. | Take **one** real aesthetic risk where it serves the work |

---

## 8. Medium-specific systems

Claude loads different guidance depending on where the design will appear. Each one is a small, opinionated system.

### 8a. Artifacts (stand-alone HTML pages)

- **Choose utilitarian or editorial first.**
- **Tokens in `:root`**, with theming built in this order:
  ```css
  :root { /* light palette */ }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { /* dark palette */ }
  }
  [data-theme="dark"] { /* dark palette */ }
  ```
  This respects the OS setting, but an explicit theme toggle still wins.
- **Layout defaults:** 16px minimum gutter on mobile, ~65ch measure for prose, `text-wrap: balance` on headings, `tabular-nums` for figures.
- **Complete at rest:** no content hidden behind scroll-triggered reveals or "click to see."
- **Dashboards:** summary before detail; show state through form, not color alone.
- **Pinned CDN versions** for any library.
- **Review:** one rendered check, then publish.

### 8b. Inline widgets and diagrams (visuals shown inside chat)

This is a strict visual language meant to look native inside the chat:

- **Flat and seamless:** no gradients, no drop shadows, transparent background, no outer padding.
- **Two font weights only:** 400 and 500. Sentence case.
- **Outline icons** (Tabler-style) at one consistent stroke.
- **SVG diagrams use a 680px-wide viewBox.** Text sits in boxes with 0.5px strokes. Box widths are estimated at **~8px per character** so labels never overflow.
- **Nine color ramps.** Text on a colored fill uses the **800/900 step of the same ramp**, never plain black or white, so it stays legible and on-palette.
- **Pick the diagram type from the request's verb:**
  - "explain how X works" → illustrative diagram
  - "walk me through the process" → flowchart
  - "show the architecture" → structural or box diagram
  - "show the cycle" → stepper
  - "show the data model" → Mermaid ER diagram
- **A complexity budget:** if it needs more than about a dozen nodes, split it or simplify. A diagram that needs a legend to decode has failed.
- **Dark mode is mandatory:** every color comes from CSS variables that switch with the theme.

### 8c. Claude Design System (CDS): Claude's own product UI

- **Layered tokens:** palette → ramps → elevation → purpose (what each component uses) → density → motion. Components only ever read purpose tokens.
- **One accent per view.**
- **Clay (the warm orange) is reserved for things Claude starts.** It signals "the AI did this." Serif type is Claude's "voice." Both carry meaning, so they're never decoration.
- **Restraint over options:** at most two floating elevation levels (e.g. popover and modal). If you need a third, the design is wrong.
- **Content voice:** sentence case, verb-first CTAs, helpful errors, no "please," "successfully" or "simply."

### 8d. Data visualization (`dataviz` skill)

- **Choose the chart type first, color last.** Ask what comparison the reader needs to make:
  - change over time → line
  - comparing categories → bar
  - part of a whole → stacked bar (rarely pie)
  - distribution → histogram or box plot
  - correlation → scatter
- **Sequential palette by default.** Use categorical colors only when the series are truly unrelated categories.
- **The categorical palette has a fixed order.** Series 1 always gets color 1, so the same entity keeps the same color across every chart in a report.
- **Status colors are reserved** for status, never for an ordinary series.
- **One y-axis only.** Dual axes mislead. Use two charts instead.
- **Mark specs:** bars no more than ~24px thick; lines 2px; a 2px gap of surface color between adjacent marks, such as stacked segments.
- **Direct labels beat legends** where they fit. Tooltips add detail; they never carry the main message.
- **Stat tiles and KPIs:** number, label, change, in that order of emphasis. The comparison period is always stated.
- **Validate the palette** for contrast and color-blind safety in light and dark mode before shipping.

---

## 9. How the user's own system sits on top (Gyro)

On this machine, Claude also loads the user's **agent-design-system** kit (based on rico's article, compiled for Gyro). **Where it applies, it wins over everything above.**

Its core rules:

1. **Find the project's real tokens first.** Gyro's website uses Geist and its own tokens (`--bg`, `--text`, `--muted`, `--line`, `--hairline`, `--blue`). Use those, not the kit's starter zinc and Inter values.
2. **Never invent values.** Every color, size, space, radius, shadow and duration comes from the token file. If a value is missing, stop and ask. No 13.5px fonts or 10px gaps.
3. **Semantic tokens only in components:** `var(--text-muted)`, never `var(--gray-500)` or `#71717a`.
4. **Only use components and variants that exist.** If it isn't documented, it doesn't exist.
5. **Build screens as stacks of named blocks.** Each block covers its loading, empty and error states. If a screen can't be described as blocks, treat that as a sign the product itself may be off, and ask.
6. **One primary button per screen.**
7. **Status colors only for status.**
8. **`TODO(ask)` means ask; never guess.** Open items in the kit include the dark-mode mapping, the brand/accent color, the code/syntax palette and density.
9. **If the kit conflicts with the codebase,** report the mismatch rather than quietly picking one.

The three paired skills turn these rules into a workflow:

- **`/new-screen`:** state the screen's job → break it into blocks, each with its states → list gaps → name the one primary action → **stop for approval** → build → run review.
- **`/review-screen`:** a nine-point check:
  1. No raw values.
  2. No primitive tokens in components.
  3. All states present.
  4. Status text matches the real state.
  5. Only one primary action.
  6. Status colors used only for status.
  7. Only existing components used.
  8. Visible focus states.
  9. A pass/fail report with `file:line` references.
- **`/capture-rule`:** when an agent gets something wrong, record what it did, what was wanted and why. That becomes the next rule.

**The idea behind it:** the factory guidance supplies taste, and the project kit supplies *this product's* decisions. Guesses that nobody corrects slowly become the product, so write the decisions down.

---

## 10. Copy-paste kit for another agent

### 10a. Design brief prompt (paste before any design task)

```text
You are the design lead at a small studio. The client has rejected templated
work and wants a specific point of view.

Before writing any code:
1. GROUND: Describe what this subject looks like in its own world (materials,
   artifacts, colors, typography it's associated with).
2. PLAN: Write a token plan —
   - 4–6 named colors with hex values and a job for each (exactly one accent)
   - display + body (+ optional mono) typefaces with roles and reasons
   - a type scale and the weights you'll use
   - an ASCII wireframe of the first screen
   - 3–5 one-line principles specific to this project
3. REVIEW: For each line of the plan, ask "would I produce this for any similar
   page?" Revise anything generic. Check against these defaults and avoid them
   unless the subject truly demands them:
   cream+serif+terracotta · near-black+acid-green · broadsheet hairlines ·
   SaaS card grids with soft shadows · purple-blue gradients · ALL-CAPS eyebrows ·
   "A · B · C" meta strings · 01/02/03 fake numbering · one accent-colored headline
   word · arrows on every link · monospace-as-decoration.
4. DECIDE MODE: utilitarian (obvious and fast) or editorial (memorable, one risk).

Then build:
- All tokens in :root; light + dark palettes; no stray hex values.
- Body text ≤ ~65ch; text-wrap: balance on headings; tabular-nums on figures.
- Complete at rest: nothing important hidden behind scroll or click.
- Boldness in one place; everything else quiet. Remove one decorative element
  before you finish.
- Real copy: sentence case, verb-first buttons, errors that say what happened
  and what to do, no "please / successfully / simply / seamlessly".

Then verify:
- Render, screenshot, and critique against your plan. Fix what's off.
- Check mobile (~375px), dark mode, contrast, focus states, empty/error states.
- One final rendered check, then ship.
```

### 10b. Pre-ship checklist

**Plan**
- [ ] The design idea comes from the subject, not a house style
- [ ] 4–6 colors, each with a job; exactly one accent
- [ ] A deliberate type pairing; not the families used on every project
- [ ] The plan was reviewed against the anti-pattern list (§5)
- [ ] Mode chosen: utilitarian or editorial

**Craft**
- [ ] One clear focal point (squint test)
- [ ] Body text measure ≤ ~65–80ch
- [ ] Consistent spacing scale; no one-off values
- [ ] Balanced headings; tabular figures in numeric columns
- [ ] Boldness spent in exactly one place
- [ ] One decorative element removed before finishing

**States and accessibility**
- [ ] Loading, empty and error states exist where data can be missing
- [ ] Status text matches the real state
- [ ] Status colors used only for status
- [ ] WCAG AA contrast in light **and** dark mode
- [ ] Visible keyboard focus; `prefers-reduced-motion` respected
- [ ] Works at 375px with no overflow or clipping

**Words**
- [ ] Sentence case; verb-first actions; consistent action names across states
- [ ] Errors explain what happened and what to do next
- [ ] No filler words or mannered rhetorical devices

**Verification**
- [ ] Rendered and screenshotted; critiqued against the plan
- [ ] One final check, then shipped

**Project overrides (when a design system exists)**
- [ ] Only the project's real tokens; nothing invented
- [ ] Only components and variants that exist
- [ ] One primary action per screen
- [ ] Every `TODO(ask)` was asked, not guessed

---

## 11. Sources (on this machine)

| Source | Path or origin | Status |
|---|---|---|
| `frontend-design` skill (factory) | `~/.claude/plugins/cache/claude-plugins-official/frontend-design/1.1.1/skills/frontend-design/SKILL.md` | Read in full |
| Artifact design and editorial guides (factory) | Loaded from the `claude-artifacts` server's `guide` tool | Read |
| Inline widget and diagram guide, plus CDS and dataviz modules (factory) | Loaded from the visualize server's `read_me` tool | Read |
| `dataviz` skill (factory) | Available skill; its rules are summarized in §8d | Summarized |
| `agent-design-system` kit (user) | `~/.claude/skills/agent-design-system/SKILL.md` and `kit.md` | Read (kit partly) |
| `/new-screen`, `/review-screen` (user) | `~/.claude/skills/new-screen/`, `~/.claude/skills/review-screen/` | Read |

Hex values and numbers quoted here are the reference points the guidance itself uses. Treat them as markers of a cluster to avoid, not exact forbidden values.
