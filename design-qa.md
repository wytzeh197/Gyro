# Gyro editorial website QA

final result: passed

Reviewed 2026-10-02 on `codex/site-editorial-premium`, after fetching and pulling `origin/main` at `1a11c50ee3f3299d9d65a94a8f069271246ecc68`. The pull updated the model catalog and preserved the website work. The prior desktop-app review is preserved unchanged in [design-qa-desktop.md](design-qa-desktop.md).

## Findings

No actionable P0/P1/P2 differences remain within the approved website scope. The homepage has the fixed ten-part order, the white Review and footer revisions, and Claude/OpenAI/Grok marks in Getting started. Later sections use different compositions. Light mode has porcelain page surfaces throughout; dark mode applies the existing graphite palette.

## Source, render, and normalization

- Source visual truth: `/Users/wytze/.codex/visualizations/2026/09/30/01a0f2ab-428f-7b41-9639-66081e6b2cb5/site-design/sections.md` and its `sections/` images.
- Rendered implementation: `http://127.0.0.1:8081/`, built from this worktree's `site/dist`.
- Evidence directory: `/Users/wytze/.codex/visualizations/2026/09/30/01a0f2ab-428f-7b41-9639-66081e6b2cb5/site-design/implementation/`.
- Latest browser screenshots: `desktop-light.png` and `desktop-dark.png` (1440 × 7575 pixels), `mobile-light.png` and `mobile-dark.png` (390 × 6972 pixels), plus 320px narrow-screen captures.
- CSS viewport: desktop 1440 × 1000; mobile 390 × 1000. Browser screenshots are emitted at CSS-pixel resolution, including on a device-pixel-ratio-2 display. No density scaling is inferred from the physical display.
- State: homepage, light theme, initial Grok Build, Direct the work, Apple Silicon, all FAQ answers collapsed. Dark and interaction captures are identified separately.
- Full comparisons: `comparison-01.png` through `comparison-10.png` combine the approved source and the actual rendered section in the same image. Each proportional tile is 720px wide. Source canvas padding remains visible but is excluded from mismatch findings; section heights follow intrinsic content and the user's spacing specification.
- Focused comparisons: `focused-review-comparison.png` aligns the two Review panels to judge selected file, comparison control, and changed lines. `comparison-09-open.png` compares the privacy FAQ answer in the open state. `desktop-hero.png`, `mobile-hero.png`, and `mobile-320-hero.png` retain native screenshot resolution for text and header inspection.

| Section | Approved source | Source pixels | Rendered section pixels |
|---|---|---|---|
| 01 | 01-hero.png | 1465 × 1074 | 1440 × 682 |
| 02 | 02-proof.png | 2103 × 748 | 1440 × 131 |
| 03 | 03-providers.png | 1681 × 936 | 1440 × 541 |
| 04 | 04-three-views.png | 1487 × 1058 | 1440 × 974 |
| 05 | 05-review-v2-white.png | 1487 × 1058 | 1440 × 1027 |
| 06 | 06-ownership.png | 1464 × 1074 | 1440 × 1247 |
| 07 | 07-getting-started-v2.png | 1882 × 836 | 1440 × 459 |
| 08 | 08-download.png | 1590 × 989 | 1440 × 861 |
| 09 | 09-faq.png | 1465 × 1073 | 1440 × 760 |
| 10 | 10-footer-v2-white.png | 1681 × 936 | 1440 × 893 |

## Comparison history and fixes

1. **P2: overly tall Review detail.** The original narrow 840 × 940 crop expanded into a tall desktop frame and repeated the previous section's proportions. Captured a wide panel from the real Gyro development UI, retained that authentic 960 × 600 source, and produced a 934 × 449 desktop crop. The mobile crop preserves the changed lines. Post-fix `comparison-05.png` and the focused comparison show a 1248 × 601 desktop frame with the selected file and red/green change visible.
2. **P2: idle space in the hero visual.** Trimmed the authentic desktop Review master to 2040 × 1320 while keeping prompt, response, edited file, and Review action. `comparison-01.png` and `desktop-hero.png` confirm the meaningful product content aligns with the opening copy.
3. **P2: stretched download action and weak app identity.** Centered the action at 280px on desktop, retained full-width behavior at narrow mobile widths, and sized the authentic app icon to 112px using its actual 512 × 512 intrinsic dimensions. `comparison-08.png` confirms the centered hierarchy and real release metadata.
4. **P2: muted primary footer line and cramped focused FAQ answer.** Applied primary text color to the first footer sentence and added 12px above FAQ answer content. `comparison-10.png` and `comparison-09-open.png` confirm the corrected hierarchy and separation from the keyboard outline.
5. **P2: compact-section and narrow-header spacing drift.** Applied 40px desktop/32px narrower compact-section padding, 20px gutters at 390px and 16px below 390px, and 16px narrow-screen navigation controls. Refreshed all ten comparisons on October 2; the final 320px and 390px captures and `responsive-matrix-final.json` show no overflow.

## Required fidelity surfaces

- **Fonts and typography:** self-hosted Inter Tight for display/wordmark and Inter for body/controls. Native HTML follows the approved 64–72px hero, 52–60px desktop section headings, and readable mobile sizes. The desktop headline breaks after AI; narrow layouts wrap naturally. Provider names reserve the widest footprint. Supporting text, body line height, control labels, and code detail remain readable without copying generated screenshot lettering.
- **Spacing and layout rhythm:** 1248px grid at 1440px with 96px side margins, intrinsic section heights, consistent gutters, fine separators, and restrained product frames. The first four retain their asymmetric/strip/centered/selector compositions. Review is centered and wide, Ownership is visual-led, Getting started is a compact sequence, Download is centered, FAQ is ruled, and Footer has a large unclipped wordmark.
- **Colors and tokens:** light background #f7f7f7, white panes, primary #18191a, muted #676b70, blue #2b61d6. Dark mode uses the existing graphite/near-white palette and switches product captures. Red and green stay within actual code/status UI. The small authentic app icon retains its original black background.
- **Image quality and fidelity:** authentic local screenshots and provider marks replace generated UI/logo approximations. Original source masters remain unchanged. Each derivative has explicit dimensions and crop provenance; aspect ratios are preserved. The ownership photograph is a 1586 × 992 transparent WebP, 55,130 bytes, with real light/dark screen imagery underneath the measured aperture (left 13.37%, top 8.57%, width 72.95%, height 70.06%). Official source folder/terminal icons and the vendored OpenAI knot retain attribution. No generated screen lettering is displayed.
- **Copy and content:** exact approved hero and section copy, eleven supported providers in their original order, factual proof/FAQ content, real release version/date/architecture/size, architecture-specific fallbacks, and existing shell destinations. Secondary-page main HTML is byte-identical to the pulled baseline.

Expected differences from generated concepts: the written typography and spacing specification controls native HTML sizing; unused image canvas padding is omitted; authentic app chrome, logos, and app icon take precedence over generated approximations; eleven supported agents replace the concept's extra mark; real release metadata stays visible. The FAQ starts collapsed as specified, with a separate open-state comparison. These are approved constraints, not unresolved visual findings.

## Automated validation

Required commands pass:

```text
node scripts/check-download-site.mjs
node scripts/build-download-site.mjs
git diff --check
```

The existing checker retains security, safe-release URL, timeout, fallback, checksums, nested routes, model catalog, and deterministic-build checks. It now also verifies approved section order/anchors, one homepage download surface, provider/step marks, all built assets, master and derivative dimensions, crop provenance, and focused runtime behavior. Provider tests cover manual pause/resume, keyboard/hover/document/offscreen pauses, reduced motion, timer cleanup, and the optional-IntersectionObserver visibility fallback. View and theme tests cover control state, focus-preserving switching, persistence, failed storage, and disclosure navigation.

## Browser verification

- Homepage in both themes at 1440, 1024, 768, 390, and 320 CSS px; final matrix reports zero horizontal overflow and wordmark scroll width equal to its container at every size.
- Install, Changelog, and Privacy shared shell in both themes at 1440 and 390px; all three main bodies compared byte-for-byte against HEAD.
- Theme defaults light, switches, persists on reload/across routes, and works with blocked storage in the focused fixture.
- Eleven provider selections, long-name fit, persistent manual choice, pause/resume, keyboard-focus pause, and offscreen fallback checked. Three views select the correct captures; keyboard activation preserves focus and stage dimensions.
- Mobile native menu opens with keyboard, Escape and link selection close it, and anchor links resolve below the sticky header. FAQ uses native details; Enter/Space and multiple open answers work without clipping.
- Download fixture cases: valid release, API failure, malformed release, missing Intel build, and delayed architecture hint after a manual choice. Live smoke on October 2 resolved alpha.49.7, published September 28, to the selected aarch64 DMG (13.6 MB) and x64 DMG (14.2 MB), with release notes intact. No binary download was initiated.
- Script-free HTML fixture shows the three views sequentially, an initial readable noninteractive provider roster, and GitHub download instructions. Optional animation APIs can be unavailable without breaking controls.
- Final homepage browser logs contain no warnings or errors. Asset/link checks pass. Fonts and icons remain local; release metadata is the existing GitHub API request; no analytics or video were added.
- Detailed evidence: `responsive-matrix-final.json`, `secondary-shell-matrix.json`, `browser-scenarios.json`, `interaction-checks.json`, and corresponding screenshots in the evidence directory.

## Limits and follow-up polish

Native OS reduced-motion settings, the browser's actual JavaScript-disable switch, physical touch input, network-throttled loading, and native 200% browser zoom were not exercised. Reduced-motion behavior was tested with matchMedia/runtime fixtures and CSS guards; JavaScript absence used a script-free HTML fixture; 720px CSS reflow was inspected as a 200%-zoom-equivalent layout check. Image dimensions and font preloads reserve layout, but do not prove behavior under every network condition. These limits do not leave an observed P0/P1/P2 defect.

Product captures use the actual Gyro development fixture with synthetic example content; they do not establish live-provider performance or installed native-app behavior. GitHub push and website deployment are separate actions.

## Implementation checklist

- [x] Pull current main safely into the isolated site branch.
- [x] Implement all ten approved compositions and shared shell.
- [x] Preserve authentic assets, theme contract, downloads, secondary bodies, CSP, and routes.
- [x] Fix actionable visual findings and inspect combined post-fix comparisons.
- [x] Verify focused runtime behavior and responsive layouts.
- [x] Save desktop/mobile screenshots and this QA record.
