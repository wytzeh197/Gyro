# Image generation prompts

Built-in image_gen was used. Each image depicts one coherent direction across four scenarios. Source screenshot and actual Gyro logo were attached to every call.

## Image 1

Use case: ui-mockup.
Create a realistic, production-quality UI concept board for Gyro, a macOS coding-agent workspace. This is the single design direction "Native compact", demonstrated in four different states of THE SAME component. This is a brainstorming artifact, with sample task data, not implementation.
Input images: image 1 is the user's CURRENT menu bar popover screenshot, to preserve the small native utility character and Gyro identity while improving hierarchy; image 2 is the actual Gyro logo asset. Use the logo faithfully, white on dark, no replacement mark.

Canvas: 1600 x 1200 landscape comparison sheet. Title at top "Native compact" and small subtitle "One quiet menu. Four useful states." Four distinct examples laid out in a spacious 2-by-2 grid, labeled outside the UI "Idle", "Working", "Needs you", "Finished". It is ONE coherent design direction across four scenarios, not four different ideas. Each popover represents a natural 372px-wide macOS menu bar panel enlarged consistently for legibility. Height hugs content, so idle is much shorter than attention. No large app dashboard or browser frame. Background is a plain warm-neutral light gray comparison canvas, with faint context strips of blue macOS menu bar immediately above each dark panel. Tiny white Gyro menu-bar glyph anchors each panel. Keep panels entirely visible with plenty of space and no overlaps.

Actual product tokens: charcoal menu background #161617, text #f4f4f5, muted #a1a1a6, fine white border 11% opacity, divider 7.5% opacity; subtle native shadow. Panel corner radius10 logical px, controls6, icons4. Mac-like system/Inter typography 13px primary,12px secondary,11px metadata at logical size. Insets14, gaps10, row44. Use larger rendered scale for this sheet, no unreadably small type. Semantic colors only: running #6f9df4, attention #e4aa52, completed #65c68f, failed #de7474. Idle stays neutral, no success green. No purple, no gradient fills, no decorative colored badges, no large illustrations.

Information and exact copy:
IDLE: compact single identity row, original white logo without its extra outlined square, "Gyro" semibold, small neutral dot and "Ready" right. One clear full-width menu command below "Open Gyro" with subtle arrow at right. A gear remains a separate, small secondary footer control; visible label "Settings" if room. Do not pad idle into a tall empty card. No invented keyboard shortcut.
WORKING: same small header, "Gyro" left, "2 running" right with subtle blue indicator. Two plain separated task rows, "Fix menu bar layout" with muted "Editing components", elapsed "2m 14s"; "Review changes" with muted "Reading files", elapsed "48s". Task name is the primary click target. Tiny outlined square stop control on far right is quiet and distinct. Footer "Open Gyro" and gear. No invented percentage bars, time estimates, token counts or costs.
NEEDS YOU: same small header, "Gyro" and amber "1 needs you". Task row "Fix menu bar layout". Context line "Permission to run a command". Monospaced exact command "pnpm typecheck". Primary compact amber-tinted button "Approve once", secondary "Open chat". One quiet text row below "1 other task running". Footer Open Gyro and gear. Do not use alarm-red for ordinary permission.
FINISHED: same small header, "Gyro" with small green check and "Finished". One recent task row "Fix menu bar layout", secondary "Task finished". Action row "View result" with chevron as primary navigation. Footer Open Gyro and gear. Do not claim code changes passed tests.

Create crisp high fidelity UI with alignment, purposeful spacing, strong legibility and restrained native material. No cards inside cards, no metric dashboard, no additional navigation or made-up product features, no watermarks. Current date anchor November 7, 2026; no date needs to appear.

## Image 2

Use case: ui-mockup.
Create realistic, production-quality UI design for Gyro, a macOS coding-agent workspace, with clear hierarchy, strong typography and purposeful spacing.
SINGLE design direction: "Activity glance". Show this ONE design language across four distinct states of the SAME menu-bar popover. This is a concept board with fictional sample tasks, not implemented UI.
Input images: image1 is the user's current menu-bar screenshot, a product and density reference, image2 is the real Gyro logo to reproduce faithfully as a white silhouette with no square tile. Improve the current hierarchy while preserving the small utility-menu scope.

Composition: 1600x1200 landscape board, generous light neutral gray canvas, bold editorial title "Activity glance" and small subtitle "The task is the headline." A clean 2x2 grid with labels "Idle", "Working", "Needs you", "Finished" outside the panels. Natural logical popover width372px, enlarged consistently on the board for readable text, heights fit content. Only the dark floating popovers, no blue desktop strips, no browser or full application shell. All panels entirely visible; exact same column width. Native subtle shadow,10px logical corner radius, white border at11% opacity. This is not four unrelated UI ideas.

Actual menu tokens: #161617 dark panel, #f4f4f5 text, #a1a1a6 secondary, #252525 quiet inset command, running blue #6f9df4, warning amber #e4aa52, success green #65c68f, error red #de7474, separator white7.5%. System/Inter type, 13px primary,12 secondary,11 metadata logical size;16px may be proposed for the state heading. Insets14px, gap10px, controls6px radius. No purple or decorative status colors.

Distinctive structure: a TINY quiet identity header in every panel: white actual Gyro mark, "Gyro" small semibold left, gear icon in top right. Then the CURRENT TASK OR STATE gets the visual prominence, instead of a redundant oversized brand header. Bottom stays one slim divider-separated "Open Gyro" row with right chevron. No separate Settings footer row. No nested task cards: tasks form one clean continuous list with fine dividers and tiny status glyphs.

Exact content per state:
Idle: small brand header, state heading "No tasks running", subtle secondary "Ready when you are". Bottom single full-width primary navigation "Open Gyro" with chevron. Keep this state compact, no large empty illustration, no history if there is no work.
Working: small brand header. Modest state heading "2 tasks running", blue small activity glyph. First task "Fix menu bar layout", secondary "Editing components", small metadata "Claude · 2m 14s". Second task "Review changes", secondary "Reading files", metadata "GPT-6 · 48s". Time aligned as tabular figures; each task row includes a very quiet square Stop icon right, does not compete with task titles. Footer Open Gyro with chevron. No percentages or fabricated ETA.
Needs you: small brand header. State heading "Approval needed" with tiny amber diamond. Task name "Fix menu bar layout"; secondary "Claude wants to run". Monospaced "pnpm typecheck" as compact code block. One primary blue or neutral clear button "Approve" and secondary text action "Open chat". A plain quiet lower row "Review changes" plus blue activity glyph and "Still running". Footer Open Gyro. No destructive red, no extra dashboard.
Finished: small brand header. Modest state heading "Task finished" and small green check. Task title "Fix menu bar layout", secondary "Ready to view". One clear button "View result". Footer Open Gyro. No unverified tests, changed-file counts, costs, duration statistics or shipping claims.

Keep one clear primary action per state. Use whitespace, grouping, alignment and type before borders. Do not add badges, metrics, filters, menus, graphs, decorative cards, placeholder drawings, giant titles inside the UI or invented product features. Retain restrained native Mac feel, crisp readable text, realistic density. The board title can be larger than UI typography. Current date anchor November7,2026; no dates visible.

## Image 3

Use case: ui-mockup.
Create a realistic production-quality concept board for Gyro's macOS menu bar popover. SINGLE design direction "Next action". Demonstrate the same coherent component across four states, with sample task data. The idea is attention-first: give a small popover one job, make the next useful action obvious, and summarize less important background activity.
Input references: image1 is the CURRENT Gyro menu screenshot, preserve restrained dark native utility identity and compact menu scope; image2 is the ACTUAL Gyro mark, render it faithfully white, no substituted logo.
This is visual ideation only.

Canvas1600x1200 landscape, pale neutral gray background. Top title "Next action", subtitle "One useful thing at a time." 2x2 grid labeled outside the UI "Idle", "Working", "Needs you", "Finished". Four panels, all372 logical px wide enlarged consistently for legibility, natural heights. No browser, full app, desktop clutter or giant device frame. This is one design direction showing scenarios, not multiple visual ideas.

Product style: dark #161617 surface, #f4f4f5 type, secondary #a1a1a6, line white7.5%, border white11%, radius10 logical px, controls6px, gap10px, inset14px. Mac system/Inter13px primary,12px secondary,11px meta logical size, proposed16px task/action headline. Blue #6f9df4 means running or primary action, amber #e4aa52 means needs input, green #65c68f means complete, red #de7474 means failure only. Avoid colorful decoration, gradients, glass effects, nested cards and heavy borders.

Distinct structure: low emphasis top chrome with tiny actual Gyro logo + "Gyro" at top left and small gear at top right, no separator under this chrome unless necessary. Main area uses a state label in small secondary type, then ONE prominent task or next action headline. A restrained colored vertical2px status line beside just the meaningful task area can tie label and detail together. Only the attention state gets amber; no color for idle. ONE clear action button aligned full width beneath main content, neutral light contrast with dark label, not oversized or marketing-like. Supporting activity stays a SINGLE thin clickable summary row with chevron. A quiet bottom-left text link "Open Gyro" remains secondary in busy states. Minimal hairlines only when needed. Aim for deliberate focus rather than an activity dashboard.

Exact copy and layout per state:
IDLE: tiny brand header. Modest headline "Ready when you are". Secondary "No tasks running". Single clear full-width light-neutral button "Open Gyro" and right arrow. Nothing else. Very short panel, no unnecessary footer duplication, no enormous whitespace.
WORKING: tiny brand header. Small blue label "Working". Task headline "Fix menu bar layout". Secondary "Editing components", then muted time "2m 14s elapsed". Primary full-width button "Open task". Thin supporting summary row "1 more task running" with right chevron. Quiet "Open Gyro" footer link. NO percentage, no fabricated ETA, no statistic tiles.
NEEDS YOU: tiny brand header. Small amber label "Needs your approval". Task headline "Fix menu bar layout". Context "Permission to run a command". Code in a simple small inset monospace row: "pnpm typecheck". ONE clear full-width light-neutral button "Review request" with arrow. Do not approve blindly in this design; this button opens the request and task context in Gyro. Supporting summary row "1 task running" and blue status dot. Quiet Open Gyro footer link. No red, no second competing primary action.
FINISHED: tiny brand header. Small green check + label "Finished". Task headline "Fix menu bar layout". Secondary "Ready to view". ONE clear full-width light-neutral button "View result". Quiet Open Gyro footer link. No test success claims, changed-file counts or invented performance data.

Keep all four panels aligned beautifully and different heights driven by content. Task title is stronger than app name, status always has text as well as a color, controls are distinct and readable. Fine subtle shadow, crisp realistic UI. No watermarks, no extra workflow tabs, history, costs, token counts, launch features or new branding. Current date anchor November7,2026; no dates need to appear.
