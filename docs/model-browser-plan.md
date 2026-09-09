# Gyro Browser as Model Eyes

Status: in progress  
Plan date: 2026-09-06

## Implementation Progress

Completed in the first shared slice:

- Added the versioned, provider-neutral `gyro.browser-observation.v1` envelope
  for Inspect, Read Page, and Screenshot results.
- Added viewport, history, ownership, timestamp, structured-page, capture, and
  bounded diagnostic evidence to that envelope.
- Corrected screenshot metadata to use the native bitmap dimensions.
- Added a deterministic loopback fixture covering responsive content, a safe
  interaction, a credential field, console output, and a failed request.
- Added contract checks for the observation envelope and acceptance fixture.
- Added explicit intent routing for requests that name Gyro's in-app, embedded,
  or Browser rail surface, plus ordinary website/domain inspection requests.
  Capable providers are directed to the exact `gyro_browser_*` tools and may
  not substitute generic web access or operating-system UI control, or claim
  unavailability without attempting the capability.

Additional implementation in the current worktree:

- MCP screenshot results now include PNG image content, read only from Gyro's
  private capture storage. Outgoing framing accommodates the bounded image;
  incoming requests and structured IPC results retain their existing limits.
- Ollama discovery distinguishes vision support from function calling. Vision
  models receive screenshot bytes through image messages; text models retain
  structured evidence without a claim of visual inspection.
- Chat-only Ollama models receive a broker-mediated read-only observation on
  explicit browser inspection requests, and screenshots when vision is supported.
  This reuses the current chat's browser and preserves policy and ownership checks.
- Chat-only prompts no longer advertise unavailable tools. Ollama retains the
  complete message payload even when no function tools are offered.
- Projectless chats now get a private, stable execution directory per chat.
  They retain the public No folder state, and manual browser opening resolves
  the same backend-owned directory as model browser calls.
- Add context → Browser captures an immutable structured observation and an
  optional screenshot in the chat's private attachment storage. The original
  URL, time and bitmap dimensions are retained. Image-capable adapters receive
  the screenshot; text-only adapters receive structured evidence and explicit
  notice that pixels were not delivered. Screenshot references undergo the
  same chat ownership and integrity validation as ordinary image attachments.
- Browser snapshots are embedded in prompts for every registered provider,
  including chat-only Ollama models. They do not require a model tool call.

Still open: exercise the full observe-act-observe loop through each adapter
class, verify actual image delivery through provider clients, visually verify
the Browser context attachment UX, and complete the acceptance matrix below.

### Verification so far

- Desktop Rust suite: 226 passed, 4 ignored. One host-routing test initially
  failed in the parallel suite, then passed both alone and in a full rerun;
  the intermittent failure remains under investigation.
- Browser wiring checks: all 15 tools pass.
- Core Rust suite: 276 passed. Ollama discovery covers all four tool/vision
  combinations; private projectless directories are stable, separate, and
  reject symlinks.
- Desktop TypeScript checking and the native development build pass.
- Image transport test covers byte-for-byte base64 decoding, output over the
  previous 1 MiB framing limit, outside-storage rejection, and denied results.
- Live native acceptance remains unproven. An isolated development app started,
  but its first Codex request stalled in Node's working-directory resolution
  before model dispatch. A projectless retry exposed empty-workspace rejection;
  the private-workspace fix passes its regression test. Retesting the rebuilt
  app now runs with isolated debug data and an incognito webview. Codex
  responds successfully; its first browser call exposed an additional
  projectless-workspace canonicalization in the capability dispatcher. That
  dispatcher now uses the same private-workspace resolver as model startup.
  Native open and initial read now pass. Codex received a real screenshot
  (its input_image bytes exactly match the native PNG) and clicked the fixture
  control, visibly changing State: initial to State: changed. A fresh run
  completed the entire loop in one turn (session 84900b76-3ab7-4b08-a461-4f7d09eb1354).
  Its Browser attachment follow-up reported State: changed and the blue Save
  button without tools; Codex user input contains the exact 108,060-byte PNG
  stored with the immutable attachment.
- Approval guidance now delegates gyro_* tool approvals to the existing broker
  rather than asking a duplicate prose question. Nonempty current-turn guidance
  also replaces stale Ask first instructions when resuming a Codex chat.
- Ollama test models qwen3:4b and gemma3:4b are installed. Live local
  inference remains unverified.
- Shared product knowledge is now compiled into provider context. Its browser
  command contract is generated from runtime schemas. See
  [product knowledge](product-knowledge/README.md) for the guide, drift checks,
  and adapter-level verification policy.

### Browser reliability regression — 2026-09-09

Native DOM tool results now return through Tauri's evaluation callback, so a
page's CSP or custom-scheme fetch restrictions cannot block the response.
Bridge telemetry uses the original fetch to avoid recursively logging itself.
Repeated page reads retain usable element references; clicks fire once; stale
explicit typing targets fail instead of typing into the focused field. Failed
DOM actions propagate as tool errors. Console and network tools read their
in-page buffers through the same native callback.

The opt-in native smoke check passes against a loopback fixture with a restrictive
CSP. It covers repeat reads, find/click/read with an exact click count, typing
and submitting, credential/stale-ref rejection, select and checkbox inputs,
scroll position, PNG capture, console/network, exact URLs after navigation and
back/forward, reload, title, and native close. Run on macOS with the dev frontend
available at its configured URL:

```sh
# In a separate terminal:
python3 -m http.server 8766 --bind 127.0.0.1 --directory scripts/fixtures

cargo build -p gyro-desktop
GYRO_TEST_DATA_DIR=/tmp/gyro-browser-smoke \
GYRO_BROWSER_SMOKE_URL=http://127.0.0.1:8766/browser-observation.html \
target/debug/gyro-desktop
```

The isolated directory receives `browser-smoke.json` and `browser-smoke.png`.
The native check exits nonzero on failure and does not run providers or read
user session storage. This hook is compiled only in debug builds.

A separate live Codex run (GPT-5.6 Sol) completed open/read twice/click/read/type
and submit/screenshot on the fixture. The native page visibly showed
`State: changed`, `Clicks: 1`, and `Form: saved Browser acceptance`.
A fresh live Codex run also read https://usegyro.io/ successfully, reported
“A place to think. A space to build.”, and received a desktop screenshot.
UI inspection confirmed the page title and visible close ×. Closing removed the
native webview; reopening showed an empty New tab. Inactive browser tabs also
retain their page title. These checks do not certify every provider adapter,
cross-origin iframe, or site requiring trusted user gestures.

Validation: the 18 browser Rust tests, desktop TypeScript check, browser
capability contract check, and chat companion check pass. The broader chat
side-panel check fails its terminal-launch assertion on both the unchanged
baseline and this patch; that pre-existing failure is outside this browser fix.

### Live acceptance matrix

Verification is by adapter boundary and capability class, not every model name.
Models on an unchanged adapter inherit its contract checks. Repeat live smoke
checks for protocol changes, new capability classes, or reported regressions.
Knowledge does not replace transport or authorization checks.

| Adapter/class | Structured page and approved interaction | Screenshot delivered to model | Immutable Browser attachment |
| --- | --- | --- | --- |
| Codex | Pass: full open/read/screenshot/click/read loop in one run | Pass: 106,666 PNG bytes in Codex input_image exactly match native capture | Pass: UI capture + 108,060 image bytes delivered as user input; model reports captured state and button colour without tools |
| Claude Code | Pass: navigate/read/screenshot/click/read, Sonnet 5 | Pass: trace contains 106,666-byte image matching native PNG | Live test exposed missing image input; structured stdin and argument-contract fixes pass checks; live retest pending |
| ACP (representative client, plus protocol exceptions) | Pending: Kimi returned an internal error; diagnostic details added | Pending representative image-capable client | Pending representative client; text-only declarations must not claim pixels |
| Ollama with tools, text-only | Pending local model | Not applicable; must not claim visual evidence | Pending local model |
| Ollama with tools and vision | Pending local model | Pending local model | Pending local model |
| Ollama without tools, text-only | Pending read-only observation; actions unavailable by design | Not applicable | Pending local model |
| Ollama without tools, vision | Pending read-only observation; actions unavailable by design | Pending local model | Pending local model |

Live verification is in progress with the isolated acceptance app. Retry its
projectless chat against
`http://127.0.0.1:8766/browser-observation.html`. Verify the heading, screenshot,
Change visible state → State: changed, and a fresh read. Then exercise Browser
attachments for affected adapter boundaries, using the shared contract tests
for unchanged model variants. Gemini currently needs authentication; this is
an environment readiness issue, not a separate model implementation. Do not mark this plan
complete while these gates remain unverified.

## Direction

Make the browser inside Gyro a provider-neutral observation surface that any
chat model can use when visual or web evidence would improve its work. Local
models are included through the same contract; they are not the feature's
primary scope.

Gyro owns the browser, its session state, evidence capture, and permission
boundary. Provider adapters only translate the shared Gyro browser contract to
and from their model. There should be no provider-specific browser behavior in
the product surface.

The intended loop is **open, observe, act if approved, observe again**. A model
must not claim that a page works or looks correct until the resulting browser
state supports that claim.

## What “Eyes” Means

Every model should receive the strongest browser evidence it can consume:

- **Universal structured view:** URL, title, viewport, accessibility tree,
  visible text, interactive element refs, and bounded page state.
- **Visual view:** A real screenshot delivered as image input when the selected
  model accepts images.
- **Diagnostic view:** Bounded console errors and network request summaries
  when debugging a web application.
- **Read-only fallback:** Models without native function calling receive a
  host-mediated observation of the current Gyro Browser instead of losing the
  browser entirely. Interaction remains unavailable unless Gyro can govern it
  reliably.

Text-only models can still inspect page structure, content, controls, and
diagnostics. They must not describe pixel-level appearance unless they received
visual evidence or Gyro supplied a trustworthy derived description.

## Current State

The shared foundation largely exists:

- Every executable provider adapter is eligible for the same Gyro capability
  catalog, including the browser tools.
- The browser is app-owned, private to a chat, and visibly docked in that
  chat's Browser rail.
- Gyro can open and navigate pages, read the accessibility tree, find elements,
  capture screenshots, inspect console and network activity, and interact by
  stable refs.
- Browser Inspect is read-only and allowed by default. Browser Navigate covers
  state-changing actions and asks by default.
- Observed page content is marked as untrusted, and credential-like fields are
  not writable by models.

The gaps are capability parity and proof. Tool availability does not guarantee
that every adapter transports screenshots correctly, that smaller models know
when to use the browser, or that a model without function calling can receive a
useful read-only observation. There is also no provider-wide acceptance matrix
for the complete observe-act-verify loop.

## Product Behavior

A model should reach for the Gyro Browser when:

- The user asks it to inspect a website, preview, or running app.
- It changed user-facing web UI and needs to verify the result.
- Layout, responsive behavior, rendered copy, loading state, or accessibility
  matters to the answer.
- Page state is needed to diagnose a console or network failure.
- A prior browser action needs confirmation.

It should not open the browser for ordinary code reading, non-visual backend
work, or when existing evidence already answers the question.

When no page is open, the model may open a known URL under the normal origin
approval. When the user already has a Gyro Browser page open for the chat, the
model should inspect that session-owned page rather than create another browser
context.

## Shared Observation Contract

Introduce one normalized `BrowserObservation` returned consistently through
every provider adapter:

- Browser resource and owning chat identity.
- Capture time, current URL, page title, viewport, loading status, and history
  availability.
- Bounded accessibility snapshot with visible text and stable interaction refs.
- Screenshot resource plus image content when the receiving model supports it.
- Optional bounded console and network summaries.
- Explicit evidence framing: observed page content is untrusted data, not
  instructions.
- Clear stale-state and recovery information, including when the model must
  read the page again before using a ref.

Keep observation payloads compact. Models should be able to ask for deeper
page structure, a new screenshot, or diagnostics rather than receiving the
largest possible capture on every call.

## Provider-Neutral Delivery

### Native tool-capable models

Expose the shared browser functions through the adapter's supported tool
protocol. Return the same normalized observation and errors regardless of the
provider.

### Tool-capable local models

Use the identical schemas, permission classes, result shape, limits, and chat
browser ownership. Local inference changes performance characteristics, not
browser authority or UX.

### Models without function calling

Provide a Gyro-managed read-only path:

1. Capture the current page when the user explicitly asks for browser or visual
   inspection, or when the user attaches the Browser as context.
2. Inject the bounded structured observation into the model turn.
3. Include the screenshot only for image-capable models.
4. Keep clicks, typing, form input, and navigation unavailable unless the model
   can issue a structured request that Gyro can validate and approve.

This fallback gives every model useful eyes without emulating unsafe actions
from free-form text.

## Work Plan

### 1. Prove the common path

1. Build one deterministic loopback web fixture with visible content, responsive
   layout, a state-changing control, a safe form, console output, and a failing
   network request.
2. Exercise open, inspect, read page, screenshot, find, approved interaction,
   and verification through the shared capability broker.
3. Record which adapter capabilities are native, translated, or unavailable;
   do not implement separate browser behavior per provider.

Deliverable: a provider-neutral contract test and an honest capability matrix.

### 2. Normalize browser observations

1. Add the shared `BrowserObservation` result shape.
2. Include viewport and capture freshness alongside the existing URL, title,
   accessibility data, and refs.
3. Deliver screenshots as actual image content to image-capable models rather
   than only returning a local capture path.
4. Give text-only models the structured page view without implying visual
   inspection.
5. Return actionable errors for no browser, stale refs, timeout, denial,
   cancellation, and unsupported image input.

Deliverable: the same browser call produces equivalent model-visible evidence
through every adapter.

### 3. Add the host-mediated read-only fallback

1. Let the user attach the current Gyro Browser state to a message.
2. Detect explicit requests to inspect a page or visual result when a browser
   is already open, and offer the same bounded observation automatically.
3. Keep the captured state immutable for that turn and label its timestamp and
   URL.
4. Never infer clicks or submissions from ordinary prose for a model without a
   structured tool channel.

Deliverable: a chat-only or text-only model can still reason over the current
page safely.

### 4. Teach models when and how to look

1. Add concise shared guidance describing when browser evidence is useful.
2. Prefer read page plus screenshot for initial inspection, then request
   diagnostics only when the task calls for them.
3. Require a fresh read after navigation or interaction before reporting the
   result.
4. Require models to distinguish **observed**, **inferred**, and **not
   verified** statements in their final answer.

Deliverable: browser use is purposeful and evidence-backed rather than an
automatic cost on every turn.

### 5. Keep actions governed and visible

1. Preserve per-origin approval for opening and navigating pages.
2. Keep inspection separate from actions that change page state.
3. Add a stronger approval boundary for consequential submissions such as
   purchases, publishing, account changes, or sending messages.
4. Keep credential, payment, token, and secret fields blocked.
5. Show browser calls, approvals, denials, and captures in the chat timeline and
   keep the Browser rail visibly bound to the initiating chat.

Deliverable: every provider receives identical authority for the same project
policy.

### 6. Verify across model capability classes

Test representative models by capability, not by brand:

- Tool-capable and image-capable.
- Tool-capable and text-only.
- No native function calling but image-capable.
- No native function calling and text-only.
- Local and remote execution within each applicable class.

Deliverable: failures are expressed as explicit capability limits, never as a
provider silently lacking the Browser.

## Acceptance Gate

- A model can inspect an already-open Gyro Browser without creating a second
  browser session.
- A model can open a loopback preview, read it, capture it, and report visible
  content accurately.
- Image-capable models receive pixels; text-only models receive structured page
  evidence and do not claim pixel-level verification.
- A safe interaction requires the configured approval and is followed by a new
  observation.
- Denied, cancelled, timed-out, and stale-ref actions never become success
  claims.
- Instruction-like page content remains untrusted data.
- Credential fields and consequential external actions remain blocked or
  explicitly approved.
- The same acceptance fixture passes through every shipped executable adapter,
  including local runtimes where the selected model supports the required
  capability.

## Recommended Decisions

- **Universal fallback:** Support host-mediated read-only observations for
  models without function calling. Do not emulate browser actions from prose.
- **Automatic use:** Trigger browser observation only from explicit visual/web
  intent or a model tool call, not on every turn.
- **Visual truth:** Treat a screenshot as model-visible evidence only when its
  bytes were delivered to an image-capable model.
- **Ownership:** Keep one app-owned browser resource per chat and reuse it across
  turns until the user closes it.
- **Provider design:** Keep all browser logic in Gyro's shared broker; adapters
  translate transport only.

## First Implementation Slice

Create the loopback acceptance fixture and normalized `BrowserObservation`,
then prove one tool-capable image model and one tool-capable text model receive
the correct evidence from the same Gyro Browser session. This establishes the
shared contract before adding the read-only fallback for models without native
tools.
