# Remote model catalog

Gyro keeps its bundled provider catalog as the offline baseline. Desktop startup
restores the last validated remote catalog before config normalization, then
refreshes in the background after the shell loads. A focused, visible window
checks once a minute, a background app once every six hours, and regaining focus
or coming back online checks immediately. A check that adds models raises a
**provider** notification naming them, so a published addition appears in the
picker without anyone watching for it.

The client fetches `https://usegyro.io/model-catalog.json` through a dedicated
native command. It sends no provider credentials or workspace data, refuses
redirects, limits responses to 256 KiB, and times out after ten seconds.
Transport or validation failures preserve the last working catalog. Storage
failure still allows updates for the current app session. The document is served
with a one-minute revalidating cache, so a live revision reaches a polling client
in about a minute.

## Publishing a model addition

Edit `site/model-catalog.json`. The site build includes it as a static asset.
A model entry looks like this (illustrative ID, not a real model):

```json
{
  "schema": "gyro.model-catalog.v1",
  "revision": "2026-09-22.2",
  "enabled": true,
  "rolloutPercentage": 10,
  "models": [
    {
      "providerId": "openai",
      "id": "example-compatible-model",
      "displayName": "Example model",
      "description": "A newly supported model.",
      "minClientRevision": 1,
      "contextWindowTokens": 200000,
      "supportedReasoningEfforts": ["low", "high"],
      "defaultReasoningEffort": "high"
    }
  ]
}
```

Run `node --experimental-strip-types scripts/check-model-catalog.mjs`. Besides
validating the document, it requires every published entry to reach a picker: a
known provider, an `insertBefore` that names a model, a client revision some
release supports, and `contextWindowTokens`, `supportedReasoningEfforts`, and
`defaultReasoningEffort` filled in (an entry replaces bundled metadata whole).
Verify the model ID and options against the actual supported integration before
publishing, for example with `claude -p ok --model <id> --output-format json`,
whose `modelUsage` reports the context window the CLI really gives that ID. Deploying the site is a separate release action; editing this file
does not publish it.

Commit the change, then publish it from the private gyro-website repository
with `npm run catalog:sync` and `npm run site:deploy`. `pnpm site:deploy` in
this checkout refuses to run: it uploads `site/` to the production worker and
would replace the current website. Confirm what is actually live.
`pnpm catalog:verify` still compares the served document with this checkout.

```bash
pnpm catalog:verify
```

It fails when the served document differs from the one `HEAD` records, when the
app's parser rejects it, or when it is not served as JSON with at most a
one-minute cache. That is
the failure mode to avoid: a catalog published from an uncommitted working tree
is withdrawn the next time someone deploys from a clean checkout, and the
deployed bytes are the only copy of it. It needs the network, so it is not part
of `pnpm release:check`.

Adding a model announces it once, in the app that sees the change: the message
names only entries that were not selectable before, so a withdrawal, a rollback,
and a first installation stay silent.

The document is a complete overlay, not an accumulating patch. Matching model
IDs replace bundled metadata; new IDs are appended to their existing provider.
An empty models list restores the bundled catalog. The initial document is empty
so this infrastructure introduces no unverified models.

## Compatibility, rollout, and withdrawal

- `minClientRevision` gates entries on an explicit catalog implementation
  revision bundled into the app. Revision 1 supports only the existing provider
  integrations and reasoning vocabulary, but its Codex runner rejects
  reasoning efforts for model IDs it does not already know. Revision 2 (Alpha
  49.4) forwards any effort in the shared vocabulary for unknown Codex models
  and lets Codex validate it; new OpenAI entries need `minClientRevision: 2`.
  Increment it when a later app release adds capabilities that older clients
  cannot execute.
- `rolloutPercentage` uses a persistent installation bucket from 0 to 99.
  Raising it expands the rollout without transmitting an installation ID.
- Remove an overlay entry to withdraw it, publish an earlier document to roll
  back, or set `enabled: false` to restore all bundled entries. Already-running
  sessions retain their recorded model; this is picker rollback, not cancellation.

Saved custom models and local Ollama discovery remain intact. Catalog-derived
entries are marked in memory so normalization cannot resurrect withdrawn models.
Provider endpoints, credentials, executable settings, image/tool permissions,
and defaults cannot be changed by the document. Unknown providers and entries
requiring a later client revision are ignored. Other invalid data rejects the
whole document atomically.

## Live model context

The native `refresh_model_context_windows` command refreshes limits for each
provider/model pair without making inference requests. It reads OpenAI CLI model
metadata, advertised OpenAI-compatible API limits (including routed limits and
published aliases), and Ollama discovery. Model-specific catalog values remain
the offline baseline; an unknown model never inherits a provider-wide guess.

ACP `usage_update` frames from Grok, Kimi, Gemini, Cursor, and OpenCode now reach
the composer during the turn. Actual runtime allocations override published
maxima. One replaceable context checkpoint tracks occupancy separately from
accumulated billed usage, and catalog-only checkpoints cannot freeze a newer
model limit. Limits remain scoped to provider, model, and endpoint; key changes
invalidate the native cache. Metadata is cached for five minutes and runtime
readings for fifteen, with background startup refresh, visible-window checks,
and an immediate path for live context events. Refreshing limits does not select
another provider or rewrite user settings.

The renderer retains live metadata across model selection and config reloads.
Missing capacity stays **Unknown**, even when a provider reports tokens used.
Run `node --experimental-strip-types scripts/check-live-model-context.mjs`;
it is included in the reliability suite. The standalone
`apps/desktop/context-window-preview.html` uses the actual composer with
clearly labeled simulated runtime readings.

## Scope and release requirements

From revision 2 the native runner keeps its own copy of the catalog. The native
fetch only returns the document; the picker validates it, puts it into effect,
and then hands it to the runner (`install_model_catalog`) with its rollout
bucket, both for a fresh fetch and for the cached copy restored at startup. So
the runner holds exactly the picker's catalog: never a document the picker
refused, and never an entry outside this installation's rollout. The runner
saves it to `model-catalog.json`, and the bucket to `model-catalog.bucket`, in
Gyro's data directory, so it survives a restart without a network. The Codex, Claude, and Grok runners take a model's allowed reasoning levels from
`supportedReasoningEfforts`, and context tracking takes its window from
`contextWindowTokens`, before falling back to the bundled tables. So an ordinary
new model for an existing provider needs only a catalog entry at
`minClientRevision: 2` with both fields filled in, and no app release. The runner's
parser validates exactly what the picker's does. `scripts/fixtures/
model-catalog-parity.json` lists documents both must accept or both reject, and
the TypeScript and Rust tests each run it. A Rust test keeps the two revision
constants equal, and another checks that `site/model-catalog.json` parses
natively. `cargo test --lib the_live_catalog -- --ignored` fetches the live
document through the runner's own transport and checks it matches the commit.

The catalog does not install or upgrade provider CLIs, change authentication,
add runners, or add CLI flags. Runtime-reported context limits remain
authoritative. A model that needs any of those still needs an app release, and
that release bumps the client revision in both `remote-model-catalog.ts` and
`model_catalog.rs`. Catalog publication must account for supported CLI
versions.

Users need one app release containing this client, and the site catalog must
be deployed, before remote model additions work. The minute-level check is part
of that client, so installs on an earlier release keep the six-hour cadence until
they update, and the configured `rolloutPercentage` still decides who sees an
addition at all. No app release or site deployment is performed by this
implementation.

## Effort and context audit (2026-10-13)

`scripts/fixtures/model-metadata.json` records the checked context window,
selectable positive effort levels, default, and source for all 42 picker models.
Both the TypeScript catalog check and native tests verify it. Recheck the
integration's metadata when updating it: CLI and API limits can differ.

Codex 0.162.1 reports 500K for GPT-6.1 Sol and 272K for its other current
full-size models; GPT-6.1 Sol and GPT-5.6 Sol default to low, and both Luna
generations stop at max. Claude Code's Opus 5.5, Sonnet 5.5, and Haiku 5.5
default to medium. Haiku 4.5 does not support effort. OpenRouter publishes each
model's choices and default under `reasoning` in its public models endpoint,
so routed models must not share an assumed universal ramp.

Context limits already match the checked integrations. Runtime reports still
override the catalog: Kimi's 262,144 baseline becomes 1,048,576 on Pro and
Allegretto, and providers can reserve or allocate a smaller working window.
Cursor and OpenCode leave fixed limits unspecified because their model is
configured externally. Ollama obtains its models and allocations from the
local runtime.

Gyro's effort vocabulary excludes none/minimal and thinking toggles; the audit
covers the positive effort levels the current control can represent.

Verification: all 42 metadata checks, workspace typechecking, and the native
model/context suites pass (44 passing tests in each suite). All 18 core config
tests and the retirement guard test also pass. The standalone
`apps/desktop/model-metadata-preview.html` renders the production composer
with labeled fixtures. Browser checks confirm Sol's 500K picker label,
Luna's five effort positions, Haiku 4.5's missing effort control, and routed
DeepSeek's three positions. Four unrelated workbench smoke assertions also
fail against the pre-change source; the model assertions pass.

## Context recheck (2026-10-23)

Every picker window was checked again against the window the launched tool
serves, not the API maximum.

Grok Build 1.0.67 serves `context_window` 256,000 for Grok 4.7, 4.6, 4.5, and
4.7 Fast. 500,000 is only the optional larger window. Gyro had stored 500,000.
The xAI baselines for those four ids are now 256,000. Grok 4.3 is not in the
Grok Build model list, so it is not on the xAI CLI connection. The public API
is a different connection. OpenRouter's `x-ai/grok-4.7` and `x-ai/grok-4.6`
stay at 500,000.

CLI and API connections are separate catalog rows for every picker model.
Each row keeps the window that connection serves. The products listed on two
connections are Grok 4.7 (Grok Build 256K, OpenRouter 500K), Grok 4.6 (Grok
Build 256K, OpenRouter 500K), GPT-6 Astra (Codex 272K, OpenRouter 1.05M),
Kimi K3 (Kimi Code 262,144, OpenRouter 1,048,576), Claude Sonnet 5 (Claude
Code 1M, OpenRouter 1M), Claude Opus 5 (Claude Code 1M, OpenRouter 1M), and
DeepSeek V4.1 Flash (DeepSeek API 1M, OpenRouter 1,048,576). Matching numbers
stay when both sources serve them. Every other picker model exists on one
connection and keeps that connection's window.

Codex 0.163.0's logged-out bundled catalog lists 272K for GPT-6.1 Sol. Signed-in
catalogs through 22 October still serve 500K, which is 475K after Codex's 95%
reserve. That 272K print is a logged-out stub, so Gyro keeps 500K. The other
current Codex models stay at 272K. The API maximum remains 1.05M and is not the
Codex baseline.

Claude Code 2.1.308 serves 1M by default for Fable 5.1, Fable 5, Opus 5.5,
Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5, and Haiku 5.5. Haiku 4.5 stays at 200K.
`CLAUDE_CODE_DISABLE_1M_CONTEXT` holds a session at 200K and is not the catalog
baseline. Kimi's model page publishes exact ceilings: `k3` is 262,144 on Plus
and Moderato, and 1,048,576 on Pro and Allegretto. The offline baseline stays
at the lower ceiling, and a session's runtime window still wins. DeepSeek still
publishes 1M for Flash and V4 Pro. Mistral still publishes 256K for Medium 3.5,
Large 3 (`mistral-large-latest`), and Small 4, and 128K for Codestral. Large 4
is a separate 1M model and is not in the picker. OpenRouter's public models
endpoint on 23 October matches all 11 curated windows on both `context_length`
and `top_provider.context_length`. Antigravity, Cursor, and OpenCode still
have no fixed window.

## Provider retirement audit (2026-10-13)

`packages/ui/src/model-retirements.json` supplies the same confirmed retirement
rules to the picker and backend. GPT-5.4 and GPT-5.4 mini retired from Codex with
ChatGPT sign-in on August 31; both remain valid with API keys. The standard
picker excludes them, saved sign-in selections fall back, and a stale remote
catalog cannot reintroduce them. Codex receives explicit model IDs for
authentication-specific validation instead of silently running its default.

The backend defaults and legacy-config migration now use DeepSeek Flash/Pro
instead of `deepseek-chat` and `deepseek-reasoner` (stopped July 24), and Gemini
3.8 Flash instead of the stopped Gemini 3 Pro Preview. Known stopped API
requests fail before provider dispatch, including old automation selections.
DeepSeek's retired V4 Flash/vision aliases are also removed from saved lists.

The rules are provider-specific. OpenRouter still serves
`deepseek/deepseek-chat` through independent hosts, so that route is retained.
Custom endpoints and local model names remain intact. Deprecated models that
are still served are retained; GPT-5.5 remains available on October 13 and its
announced October 14 retirement needs the next catalog update.

Sources: [Codex model retirements](https://learn.chatgpt.com/docs/models#deprecated-codex-models),
[DeepSeek change log](https://api-docs.deepseek.com/updates),
[Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations),
and OpenRouter's public per-model endpoint lists.

## Validation

The regression script covers parsing, size limits, field isolation, picker
merging, compatibility gates, rollout boundaries, withdrawal, corrupt caches,
offline restoration, storage failures, deduplicated refreshes, and addition
announcements (the remote-to-remote diff, the gates that keep an unselectable
entry quiet, and the silence after a rollback). It also pins the focused poll
interval to a minute or less. `scripts/check-model-catalog-cadence.mjs` drives
the real hook against a controlled clock and document instead of describing it:
the focused interval, the background fallback, the immediate check when the
window regains focus or the machine comes back online, the announcement itself,
and teardown. Both run in `pnpm test:reliability`. Native unit tests cover
bounded UTF-8 transport reads.
