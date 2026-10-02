# Site asset attributions

Gyro vendors these marks locally so the public site does not contact an icon
CDN or load third-party scripts.

- `apple.svg` is the Apple mark from Simple Icons 16.21.0. Simple Icons is
  distributed under CC0-1.0. Apple is a trademark of Apple Inc.; the mark is
  used only to identify the macOS download.
  Source: https://github.com/simple-icons/simple-icons/tree/16.21.0
  License: https://github.com/simple-icons/simple-icons/blob/16.21.0/LICENSE.md
  Disclaimer: https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md
  Apple trademark list: https://www.apple.com/legal/intellectual-property/trademark/appletmlist.html
- `github.svg` is `mark-github-24.svg` from Primer Octicons 19.24.1. Octicons
  code is distributed under the MIT License. The GitHub mark is used only on
  links to the Gyro repository and follows GitHub's logo guidance.
  Source: https://github.com/primer/octicons/tree/v19.24.1
  License: https://github.com/primer/octicons/blob/v19.24.1/LICENSE
  GitHub logo guidance: https://github.com/logos

The Gyro logo and product screenshots are part of the Gyro project. The site
screenshots were captured from a local, isolated demo repository with a fake
local provider and contain no customer, account, or private repository data.

## Typefaces

- `fonts/inter-latin.woff2` is Inter, and `fonts/inter-tight-latin.woff2` is
  Inter Tight. Both are the latin variable subsets as published by Google Fonts,
  vendored here so the site loads no font CDN. Inter is designed by Rasmus
  Andersson and distributed under the SIL Open Font License 1.1.
  Source: https://github.com/rsms/inter
  License: https://github.com/rsms/inter/blob/master/LICENSE.txt

## Provider marks

The homepage's agent rotator shows eleven marks. Each was checked against its
owner's current brand source in September 2026:

- **Claude Code**: the Claude starburst from Simple Icons 16.33.0 (CC0-1.0),
  in its brand hex `#d97757`. It matches the claude.com favicon.
- **Codex**: the Codex glyph that OpenAI ships in its own desktop app
  (`codex-new.svg`). Monochrome, so it follows the page's text colour.
- **Gemini CLI**: Google's current four-colour Gemini spark,
  `gemini_sparkle_4g` from gstatic.com (the gemini.google.com icon). It is
  served unaltered as a 160px PNG (`agents/gemini-spark.png`), because Google
  publishes no vector for it.
- **Grok Build**: the Grok mark from
  [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT), matching
  grok.com's favicon. Monochrome.
- **Kimi Code**: the Kimi "K" from @lobehub/icons (MIT), matching kimi.com's own
  icon set. The accent dot is Kimi's `#1783ff`.
- **Cursor**: the cube from Simple Icons 16.33.0, matching cursor.com/brand.
  Monochrome.
- **OpenCode**: the two-tone frame from opencode.ai/brand. The dark variant is
  `#f1ecec` on `#4b4646`; the light variant is `#211e1e` on `#cfcecd`.
- **Ollama**: the llama from Simple Icons 16.33.0, matching ollama.com.
  Monochrome.
- **OpenRouter**: the glyph from openrouter.ai/brand (the July 2026 refresh).
  Monochrome.
- **DeepSeek**: the whale from Simple Icons 16.33.0, in DeepSeek's `#4d6bfe`.
- **Mistral**: the pixel M from Simple Icons 16.33.0, filled with the five
  colour rows of mistral.ai/brand: `#ffaf00`, `#ff8205`, `#fa500f`, `#e61400`,
  `#c5001b`. Mistral asks that its mark is not recoloured, so it is never shown
  in a single custom colour.

In the roster under the headline, resting marks are flattened to one ink so
they dim evenly. The active mark and any mark under the pointer always show
their own colours.

Each mark is a trademark of its owner. They appear here only to identify the
providers Gyro supports, and imply no affiliation or endorsement.

## Editorial homepage assets

- `folder.svg` and `terminal.svg` are unmodified Primer Octicons 19.24.1
  (`file-directory-24`, `terminal-24`), distributed under MIT, from
  https://github.com/primer/octicons/tree/v19.24.1.
- The getting-started OpenAI knot reuses the previously vendored Simple Icons
  mark from the Gyro site (`ecaa974d`). Simple Icons is CC0-1.0. The mark
  identifies the familiar OpenAI/GPT tool family; Codex keeps its separate
  authentic desktop glyph in the supported-provider roster.
- `ownership-device.webp` is an AI-generated hardware photograph with a
  transparent screen aperture. The screen is a separate authentic Gyro capture,
  not generated interface text. Original pixels: 1586×992. Aperture: x 212, y 85,
  width 1157, height 695. CSS uses these measured percentages.
- `screenshots/editorial-crops.json` records the source master, crop rectangle,
  and exact dimensions for each derivative. Crops preserve real UI and scale
  proportionally. The sample task is illustrative fixture evidence.

The `current-review-wide-{light,dark}.webp` masters are authentic 960×600 browser captures of Gyro’s expanded Review UI, produced with the isolated development capture fixture. Their example task and recorded patch match the original retry-limit captures. The development-only completion control was removed before capture. The desktop Review crops retain the recorded file, comparison control, and all changed lines; mobile retains the original narrow capture. No product UI was generated.
