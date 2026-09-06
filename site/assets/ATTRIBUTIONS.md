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

The Kimi and Grok marks on the homepage come from
[@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT), inlined as SVG.
The Claude, Gemini, Ollama, Cursor, and OpenCode marks come from Simple Icons
16.27.1 (CC0-1.0). The ChatGPT mark is `openai-icon` from
[Gil Barbara's logos](https://github.com/gilbarbara/logos) (CC0-1.0). Cursor and
OpenCode are shown with a "Coming soon" badge and are not yet supported. Each
mark is a trademark of its owner; they appear here only to identify the
providers Gyro supports, and imply no affiliation or endorsement.

Claude uses its brand hex `#d97757`. Gemini is drawn as its spark and filled
with an SVG gradient running violet to blue across the mark, matching how Google
renders it; the stops (`#9061c4`, `#5b83d8`, `#2e93e3`) are sampled to that
appearance rather than taken from a published spec. OpenAI, xAI, Moonshot, and
Ollama publish black-and-white marks with no brand colour, so ChatGPT, Grok,
Kimi, and Ollama follow the page's text colour and flip with the theme — except
the accent dot on Kimi's K, which is set to `#3b82f6`. Cursor and OpenCode stay
grey while they are unsupported.
