# Workspace syntax highlighting QA — 2026-10-11

## Implementation

Workspace now installs bundled TextMate highlighting for Vue, Svelte, Astro,
and indented Sass. Opening these files lazily loads the local tokenizer and
grammar assets. Highlighting works independently of language-server startup.
Existing Monaco and custom grammars keep their current providers.

The adapter uses exact `vscode-textmate@9.3.2` and
`vscode-oniguruma@2.0.1` dependencies. Twenty-eight grammars include the host
languages, required embedded HTML/JavaScript/TypeScript/CSS/SCSS, and their
injections. The [asset manifest](../../../apps/desktop/src/editor/textmate/manifest.json)
records exact upstream commits, original and bundled hashes, aliases,
conversion provenance, and licenses. Original YAML/CSON sources are retained.
Vendored bytes are excluded from formatting so provenance checks remain valid.
The production build emits all nine license/notice files, the pinned manifest,
and the source README under `third-party/textmate/`. All eleven output files
were verified byte-identical to their source files.

TextMate scopes map to the existing Gyro syntax roles, so lexical and semantic
highlighting share the light/dark palettes. Monaco receives immutable line
states and UTF-16 offsets. A cold regex compilation can exhaust TextMate's
20 ms budget mid-line; the provider completes that line again from the original
state before publishing tokens. It never carries an incomplete string or CSS
stack into the next line. A pane applies the latest completed syntax result to
its attached canonical model on mount and model switch. This fixes retained
plain-text models when cached grammar loading finishes before the React Monaco
adapter mounts; incomplete loading does not downgrade a highlighted split.

Concurrent requests share installation promises. Grammar URLs are bundled
eagerly, while their JSON bytes load on demand through retryable local fetches;
failed dynamic module imports would otherwise remain in the browser's module
map. Failed requests and malformed JSON responses are evicted from the syntax
loader and adapter caches. Each root grammar owns its registry,
so retrying one root preserves already working languages. WASM compilation
precedes Oniguruma's singleton initialization, allowing download, corrupt-byte,
and CSP failures to leave a fresh initialization possible. Failure leaves an
explicit editable plain-text fallback; reopening the pane can retry.

The desktop CSP permits local asset fetches and WebAssembly compilation with
`connect-src 'self'` and `script-src 'self' 'wasm-unsafe-eval'`. It does not add
JavaScript string evaluation. The redundant semantic-provider `didChange`
request was removed: the language-session manager already synchronizes live
text with monotonic versions before requesting tokens.

## Verification

Passed focused checks:

- UI/desktop TypeScript and editor language-session tests (12 behaviors).
- Normal production Vite build; the existing large-chunk warning remains.
- Existing syntax checks: 52 filename cases, overrides, ambiguity, shebangs,
  file limits, provider fallback/retry, semantic token validation, and themes.
- TextMate asset checks: 28 pinned grammars, 116 resolved include fragments,
  an exact list of 54 optional missing scopes, conversion sources and notices.
- Real TextMate/Oniguruma runtime tests: cold multiline comments and template
  strings, embedded scripts and styles, closing-tag boundaries, Sass mixins,
  UTF-16 positions after emoji, role mapping, scope aliases, injections,
  concurrent loads, missing/failed root retry, and independent engine failure.
- A deterministic partial-tokenization regression verifies retry from the
  original stack and publication of the completed state only.
- Code-intelligence and UI-token guards, guard registration, scoped formatting,
  and whitespace checks.
- Existing navigation/rename browser acceptance after the pane mount change:
  definitions/references, split state, rename preview/apply, dirty and unopened
  targets, undo, Save All, and recovery reload all pass. Nine narrowly classified
  Monaco Delayer disposal cancellations remain; no unexpected exceptions.

The new guards are registered in `package.json` and
`scripts/verification-map.json`. Browser and native acceptance have dedicated
`test:workspace-syntax-browser` and `test:workspace-syntax-native` runners.

## Browser and native evidence

The standard browser runner builds an immutable snapshot of the production
Monaco pane under development React and StrictMode, without LSP callbacks.
All three fresh-profile modes passed with zero browser exceptions and zero
external requests:

- Cold local loading, multiline comments/templates, embedded TS/CSS/SCSS,
  closing-tag boundaries, UTF-16 positions, unavailable Elm fallback, rendered
  light/dark colors and italic comments, then offline editing/retokenization.
- One failed WASM request, visible editable fallback, same-page retry, and
  reopening panes without losing text typed during the failure.
- One failed grammar JSON request with the same recovery requirements.

Both failure modes rerun the complete embedded-language assertions for all
four documents and wait for the retained models' CSS tokens to paint. Svelte's
background tokenization briefly starts with plain CSS after reopening; it then
matches the fresh grammar's selector, property, value, comment and closing-tag
boundaries without forced tokenization. Recovery screenshots capture that
settled state.

Warm preloaded syntax also repairs an intentionally retained plain-text model
on remount, preserving that exact model object. Four editor panes stay isolated.
Captured dark and light states at 1440×900 and 860×620 were visually inspected.

| State           | Evidence                                       |
| --------------- | ---------------------------------------------- |
| Dark, 1440×900  | [syntax-dark-1440.png](syntax-dark-1440.png)   |
| Light, 1440×900 | [syntax-light-1440.png](syntax-light-1440.png) |
| Dark, 860×620   | [syntax-dark-860.png](syntax-dark-860.png)     |
| Light, 860×620  | [syntax-light-860.png](syntax-light-860.png)   |

Recovery screenshots are retained for [WASM failure](syntax-retry-wasm.png) and
[grammar failure](syntax-retry-grammar.png).

An isolated debug Tauri executable embeds the production-mode assets and opens
an incognito native WebKit page at `tauri://localhost`, without a loopback
server or the normal application startup. It uses disposable test directories.
The explicit build feature and Vite mode exclude the harness from ordinary
application builds.

The production-CSP case passed 59 assertions, loading all 28 local grammar JSON
assets and the local WASM. It checks actual tokenization, embedded/multiline
state, Unicode, rendered dark/light styles, and editing. There were zero page
errors and zero CSP violations. A separate fresh process removed the WASM CSP
permission and passed 11 assertions: two explicit failed loads, an editable
plain-text buffer, and still-working ordinary JavaScript highlighting.
Inspect the [native production report](native-production-csp.json) and
[native blocked-WASM report](native-blocked-wasm.json).

This is real native WebKit acceptance of App-origin embedded syntax assets. It
does not claim a release `.app` bundle or full main-UI navigation/rename run.

## Scope and remaining acceptance

The bundled include graph deliberately leaves optional upstream branches such
as CoffeeScript, Stylus, GraphQL, and additional Markdown fence languages
unavailable inside these host grammars. Their separate Monaco support is
independent. Zig and LaTeX remain follow-up grammar work. Existing binary,
large-file, and minified-line policies still apply.

The wider release gates remain separate: full Workspace navigation/rename in a
release bundle, native restart persistence, and additional real-server coverage.
The existing aggregate architecture and unrelated backend test failures are
recorded in the [navigation/rename QA](../workspace-navigation-and-rename/design-qa.md).
This change does not raise those ceilings or claim a clean aggregate suite.

Changes remain uncommitted.
