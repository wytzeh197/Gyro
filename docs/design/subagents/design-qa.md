# Compact sub-agents — 10 October 2026

final result: passed

The implementation applies the approved Environment mock and compact chat summary to Gyro's existing components. The source app shell, sizing controls, and process panel are retained.

## Evidence and comparison

- Source visual truth: `reference.png`, copied from the last corrected Image Gen mock (`exec-6f81e022-ba50-4425-8693-b34f70558bae.png`). Source dimensions: 1239 × 1270 pixels.
- Implementation: `light-working.png` (1280 × 720 browser viewport), `environment-working.png` (286 × 191 component capture), `dark-small.png` (860 × 620), `light-large.png` (1280 × 720), and `refresh-error.png` (1280 × 720).
- State: Environment open, Working selected and expanded, 3 working and 6 historical completed agents in explicitly labeled local sample data. The composer summary includes only the current turn's agents and any still active workers.
- Browser density: 1 image pixel per CSS pixel. Source component crop (128, 330)–(1118, 959) was proportionally normalized to 286 pixels wide. It was never stretched to match height.
- Combined focused comparison: `comparison.png` (612 × 233), visually inspected with source and implementation side by side. Full-context evidence is `light-working.png`; unchanged app chrome is intentionally outside the source component comparison.

## Findings and repair history

1. [P2, fixed] Initial capture showed default button borders and list bullets in transcript rows. The row grid had accidentally been scoped to the composer strip and the list reset omitted. Restored the shared list reset and unscoped grid styling. Subsequent captures show flat, aligned rows in transcript, Environment and the expanded strip.
2. [P2, fixed] The first three-agent fixture assigned historical completed agents to the current turn, bloating the transcript list and dock summary. The final fixture assigns them to a previous turn. Environment retains its history count while the current-turn summary shows only its 3 agents.
3. Final comparison found no actionable P0/P1/P2 differences. Long names intentionally ellipsize in Gyro's existing 300px Environment popover; full names remain in title and accessible button labels. Status and disclosure remain visible.

## Required fidelity surfaces

- Fonts and typography: the existing Mac/system font and interface-size tokens are retained. Names have medium weight; headings, counters and secondary copy use the existing micro scale. Small/default/large modes were inspected. Native popover width can truncate long task names as described above.
- Spacing and layout: compact flat rows, quiet section divider, two status filters and an expandable dot summary follow the mock. The section is 191px high when expanded at default size. It starts collapsed; pressing a filter expands it. The composer summary stays directly above the composer. No new cards, shadows, or navigation were introduced.
- Colors and tokens: controls, selected state, status text, borders and focus use Gyro tokens. The actual agent mark is hue-rotated by stable agent ID. For fixture IDs parser/review/tests, summary and list filters match pairwise at 143°/328°/113°. The exact hues differ from the illustrative mock because real ID-derived colors are authoritative. Status never changes identity hue. A custom purple accent was also inspected.
- Image quality and assets: all dots use the existing `packages/ui/src/assets/subagent-mark.png`; the mock raster is documentation only. No replacement circles, CSS artwork, emoji, or generated UI assets are consumed. Existing Lucide disclosure icons are reused.
- Copy and content: Working and Done are the two options. Rows preserve Needs approval, Stopping, Failed, Cancelled and Interrupted when applicable. Terminal failures are available in Done; an always-visible attention action reveals the relevant group. Runtime and cumulative tokens remain in the process panel. Counts derive from actual snapshots.

## Verification

- UI and desktop TypeScript checks; desktop production build; workbench/token smoke; architecture boundary checks; diff whitespace checks.
- Sub-agent lifecycle, filter partitioning (including waiting/stopping/failure/cancellation), stable hue and preview/native parent ID checks.
- Native delegation tests: permission-mode handling, ownership, child sandbox inheritance, read-only Plan, no child delegation, follow-ups and cumulative usage. Existing Full access override and project-policy revocation tests passed.
- Capability manifest/workspace synchronization and chat run/companion checks passed.
- Browser interactions: Working/Done filtering, Enter-key activation, collapse/expand, opening a completed agent and inspecting its tokens/results, approval visibility and a sample Allow once transition, failure preservation and Retry recovery.
- Browser console error/warning logs were empty. The 860 × 620 compact dark view had no horizontal body overflow; default light and large light with a custom accent were also inspected.
- The fixture's sample-data extension initially produced a TypeScript inference error for indexed names. Added explicit snapshot-array typing and a name fallback; the final desktop type check passed.

## Permission behavior

Approve for me now promotes delegation requests from Ask to Allow within the active policy, including eligible requests already waiting when mode changes. It cannot promote an explicit Deny or bypass Council. Plan delegation remains read-only, children cannot delegate, and child native sandbox/approval settings still inherit from the parent. Full access retains the existing normal-run override. Ask for approval keeps explicit decisions. GitHub writes and unrelated capabilities are unchanged by the new auto-approval rule.

## Refresh behavior and limits

Renderer-only preview/draft IDs are excluded from native UUID lookups. Errors and refresh state are scoped to each parent chat; failure preserves known snapshots, Retry re-queries the native list, and success clears that chat's error. Raw diagnostics are disclosed under Details rather than in the primary message. Errors are visible even when the composer agent strip is collapsed.

Browser evidence uses production UI with sample data and does not establish live provider transport behavior. Native policy and inheritance behavior were unit-tested; a paid provider spawn was not run. The installed macOS app was not rebuilt or replaced. No release, commit, or publication was performed.

## Composer alignment refinement — 10 October 2026

The sub-agent dock now shares the composer's width token and 0.95 zoom factor, without scaling its own typography. Removed the strip's bottom border. Browser measurements match exactly at both widths inspected: composer and strip are 741px wide at x=57 in the regular view, and 440px wide at x=20 in a 480px narrow-pane check. The strip's computed bottom border is 0px. Evidence: `composer-aligned.png`. Workbench and UI-token checks passed. No behavioral code changed in this refinement.
