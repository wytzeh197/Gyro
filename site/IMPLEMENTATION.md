# Website implementation and maintenance

Implemented 21 September 2026. Website only; no deployment or remote push.

## Architecture and commands

`content/pages.mjs` is the single route/content registry: 15 public pages plus a
noindex 404. `templates/layout.mjs` owns shared metadata, navigation, footer,
documentation navigation, and legacy anchor compatibility. `templates/components.mjs`
owns the workflow, release rendering, and download surface. These modules are
build inputs, not browser JavaScript. The old standalone HTML sources and hand-kept
sitemap were replaced by this registry; generated HTML lives only in `dist/`.

- Build: `node scripts/build-download-site.mjs` (`pnpm site:build`).
- Check: `node scripts/check-download-site.mjs` (`pnpm site:check`).
- Preview: `pnpm site:preview`, serving `http://127.0.0.1:4175` with local Wrangler.
- Verified equivalent: `node scripts/build-download-site.mjs`, then
  `npx --yes wrangler@4 dev --config site/wrangler.toml --ip 127.0.0.1 --port 4175`.
- Refresh public releases explicitly: `node scripts/refresh-site-releases.mjs`
  (`pnpm site:releases`). Review the changed snapshot, then rebuild.

The explicit public asset list lives in `scripts/build-download-site.mjs`.
Never replace it with a recursive copy. Content sources, examples, fixtures,
this note, and test tools are not public output. Essential content is rendered
at build time. CSS and both fonts remain local. CSP adds only same-origin
connections for the public release snapshot; all existing restrictions remain.

Provider facts live in `content/providers.mjs`; both the selection and setup
pages derive from it. Update evidence and release status together. Legal body
text lives in `content/privacy.html`; only whitespace and the attribution link's
relative URL changed during migration. The existing notice date is retained.

## Claims matrix

Public-release baseline: **v0.1.0-alpha.49**, published 2026-09-21T12:35:30Z,
verified against the GitHub Releases API. The local tag's provider registry and
provider documentation match the inspected checkout. The newer local HEAD is
not used to infer shipped features.

| Claim                                                      | Evidence                                                                       | Status and allowed wording                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| macOS 14+, Intel and Apple Silicon                         | Tagged README, docs/install-macos.md; actual Alpha 49 DMG assets               | Released; name both architectures and macOS requirement                                                       |
| Free, open source, Apache-2.0                              | LICENSE, tagged README, existing privacy notice                                | Current alpha; provider charges remain separate                                                               |
| Chat, terminal, changed-file review                        | Tagged docs/architecture.md; current UI and existing captured interface        | Released; describe inspection, not universal automatic approval/rejection                                     |
| Supported CLI integrations                                 | v0.1.0-alpha.49:crates/gyro-core/src/provider_registry.rs                      | Codex, Claude Code, Kimi, Grok, Gemini supported; Cursor/OpenCode experimental                                |
| API-key integrations                                       | Alpha 48.7 public release notes; tagged docs/api-key-providers.md and registry | Released experimental; DeepSeek, Mistral, OpenRouter and custom compatible endpoints; desktop chat only       |
| API attachment capabilities                                | API guide says no attachments; registry has model-specific DeepSeek support    | Source discrepancy; do not make a blanket image-support claim; state variation and recommend text-first setup |
| Local Ollama models                                        | Tagged docs/local-models.md and registry                                       | Released; tool-capable models can use governed tools, others chat-only; no speed promises                     |
| Local sessions, cloud context leaves Mac                   | docs/privacy.md and original public legal text                                 | Existing promise; local-first does not mean cloud inference is offline                                        |
| No Gyro account/paid hosted plan; telemetry off by default | Existing public legal text, docs/privacy.md                                    | Preserve current-alpha wording; no analytics added                                                            |
| Unsigned/not notarized alpha                               | docs/install-macos.md; README                                                  | Not Developer ID signed or notarized; updater signatures are distinct; keep Gatekeeper on                     |
| Five-attempt sample and two tests                          | site/examples/retry/sync.mjs and sync.test.mjs                                 | Website illustration, not a recorded provider run; no execution-time or change-count claim                    |

Sources: https://github.com/wytzeh197/Gyro/releases/tag/v0.1.0-alpha.49 and
https://github.com/wytzeh197/Gyro/releases/tag/v0.1.0-alpha.48.7 .
The existing privacy notice is preserved, so no new substantive legal promises
need approval. Provider entitlement and pricing details are intentionally left
with each provider rather than quoting unstable prices.

## Release policy and resilience

`content/releases.json` contains twelve verified public release records and
only their DMG/checksum metadata. Draft releases returned by authenticated API
access were excluded. Never copy the unfiltered API response into public output.
The refresh command needs only public access, has an eight-second timeout,
validates URLs/data, and atomically replaces the snapshot after validation.
A failed request leaves the previous file intact. Builds never fetch releases.

Public alpha, beta, rc, and stable semantic-version tags are eligible. Historical
0.1.0 alpha 1–20 and private-preview bodies remain excluded. The default download
uses the latest published non-prerelease record, consistent with GitHub's latest
endpoint, even where its tag contains "alpha". Prereleases can appear in history.
A stale live response cannot downgrade the built snapshot. Missing architectures
and hashes remain explicitly unavailable. JavaScript-free pages show both named
DMG links and the matching SHA256SUMS link.

## Design and asset provenance

The design retains Inter/Inter Tight, the neutral theme palettes, orange details,
and the Gyro mark. The 1200px layout and 680px reading column are original choices.
Desktop/mobile Cursor homepage and product-page rendering informed the immediate
product proof and quiet surrounding UI; no Cursor assets, copy, or layouts were
imported. Mobile reference resizing required a settled second observation.

The flagship is an explicitly labelled HTML illustration based on Gyro's existing
UI, with a reproducible bounded-retry sample. Existing `hero-current-light.webp`
(1666×999) and `hero-current-dark.webp` (1660×989) were inspected as interface
references. Existing 1200×750 composed posters and theme-specific workflow films
are reused only on the product overview, labelled as example interface content.
The capture pipeline uses the actual frontend with simulated Tauri data; it is
not proof of a live provider run. No fresh native-app capture was claimed.
Attributions remain in `assets/ATTRIBUTIONS.md`.

Films are user-started, never downloaded merely because the page opens, and only
one theme's source is selected at a time. Playback pauses offscreen/when hidden;
errors reveal the poster. Reduced motion and data-saving users get a complete
static page. The primary task narrative remains readable even if all media fail.

## Verification

- Core checker: 16 routes, unique metadata/IDs, one h1, built local links and
  anchors, explicit public output, deterministic double build, security headers,
  local fonts, theme ordering, no tracking/remote assets, release validation,
  timeouts/HTTP errors/malformed JSON, and the two runnable sample tests.
- Optional DOM suite: 11 scenarios covering API failure, Intel hints, manual
  selection/checksum pairing, missing Intel asset, missing checksum, clipboard
  denial, unsafe/malformed responses, stale responses, total request failure,
  workflow selection, and no-script HTML.
- Optional motion suite: default, reduced-motion, and data-saving states;
  user-started media, correct theme paths, offscreen/hidden pause, error poster,
  and preference changes.
- Rich DOM suites use jsdom from a temporary test-tool install, not a production
  dependency. Reproduce with `npm install --prefix /tmp/gyro-site-test-tools --no-audit
--no-fund jsdom axe-core`, then set
  `GYRO_TEST_JSDOM=/tmp/gyro-site-test-tools/node_modules/jsdom/lib/api.js` when running
  `node scripts/site/check-runtime.mjs` or `node scripts/site/check-motion.mjs`.
- Local Wrangler: unknown route returns HTTP 404; install returns HTTP 200 with
  CSP, frame denial, content-type protection, referrer, permissions, and HSTS headers.
- Browser: four page patterns at 320, 390, 768, and 1440px; no page-level horizontal
  overflow. Light/dark, selected workflow panels, Intel download/hash, mobile menu
  keyboard opening/Escape focus return, and console checked.
- Test-only served variants: scripts removed from delivered HTML retain named
  architecture links; media failures retain the textual workflow explanation.
- axe-core: zero detected A/AA violations after fixing keyboard access to scrollable
  code. Full light-theme sweep plus representative dark-theme pages. Automated
  contrast and silent-video caption checks require manual review. Key text/contrast
  token pairs were calculated at 5.52:1 or higher (normal text), in addition to visual
  inspection. This is not a WCAG conformance claim or assistive-technology audit.
- Local, unthrottled, single-sample instrumented homepage timing: 1280px LCP 64ms,
  390px LCP 84ms; CLS 0 and no long tasks observed during the short sample. These
  are local lab observations, not Lighthouse scores, field INP, or percentile results.
- Route JavaScript including optional motion totals approximately 7.2 KiB gzip.

Screenshots and machine-readable browser results are saved in
`/Users/wytze/.codex/visualizations/2026/09/21/01a0c3eb-3ad3-7710-982c-f4755e7b6370/gyro-website/`
(with a working copy in `/tmp/gyro-site-review/`).
The in-app browser has no exposed browser-zoom or OS preference emulation control:
actual 200% browser zoom and native reduced-motion/data-saving switching were not
claimed. Reflow was checked down to 320px; preference behavior was exercised by the
DOM motion suite. No screen-reader audit, throttled Lighthouse run, or field
measurement was performed. No production deployment or remote push occurred.

## Visual-first homepage revision

After review, the homepage was shortened from approximately 574 to 255 words
in its main content (including all demo stages, measured from textContent).
The actual interface poster and optional film now lead, with the tested diff
selected by default in the compact workflow below. Repeated feature prose and
the homepage FAQ were removed; detailed answers remain on the linked routes.
Provider marks are extracted unchanged from the previously shipped homepage
SVGs, with existing attributions retained. Responsive 1200/2400px posters are
explicitly allowlisted. The film remains user-started.
