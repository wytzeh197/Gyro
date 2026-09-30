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
