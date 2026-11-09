# Tool reliability and browser read performance — 2026-11-07

Local changes against `ebe4ae5f439d4fd0f6a8893f31c96e25be4e966c`.
The checkout contained unrelated work, which this pass preserves. No provider
account, model selection, installed application, release, or production setting
was changed. No billable provider calls were made.

## Confirmed failures and repairs

- Streamed function names previously replaced earlier fragments: a name split
  into `gyro_workspace_` and `read` became `read`. The accumulator now joins
  fragments and tolerates gateways repeating the same complete name.
- An unnamed call was silently omitted from an otherwise valid tool batch.
  Unnamed calls, reused call IDs, and IDs that change within one indexed call
  now reject the response before its tools are returned for execution. Earlier
  completed tool rounds are unaffected; this is not a transaction rollback.
- Reading a browser subtree cleared references to other connected elements.
  Reads now prune disconnected elements and retain connected references in a
  bounded 4,096-entry cache. References include a document-specific prefix;
  navigation does not deliberately reuse the previous document's IDs. This
  prefix is an identity aid, not a security boundary.
- Browser lookup now reads associated form labels and `aria-labelledby` text,
  including multiple labels in their declared order. This improves the existing
  DOM observation; it is not a complete implementation of accessible-name rules.
- Disabled clicks and disabled/read-only form writes return errors. Selecting
  an unavailable option fails without clearing the previous selection.
- Page observations report depth, breadth, long-text, character, and node-scan
  truncation. A read visits at most 5,000 DOM nodes, including hidden nodes, so
  skipped nodes cannot cause an unbounded traversal. Use a subtree reference,
  a more precise `find`, or a deeper read to continue observing the page.
- Expanded layout wrappers no longer compute their entire subtree's `innerText`
  solely to discard that name after serializing their children. Explicit labels
  and summaries at the requested depth boundary are retained.

## Measurements

The isolated headless Brave fixture executes the injected JavaScript extracted
from `session_browser.rs`, including its real pointer helpers. Each measurement
covers a complete `readPage` call on a deterministic DOM with 35 nested layout
wrappers and long button text. Samples run on this Mac without a provider call.

| Measurement                 | Before |  After |
| --------------------------- | -----: | -----: |
| Samples                     |     25 |     25 |
| Median `readPage`           | 2.9 ms | 0.5 ms |
| Slowest observed `readPage` | 6.9 ms | 1.1 ms |
| `innerText` reads per call  |     19 |      6 |

Earlier post-change runs measured 0.5–0.6 ms median and 1.3–2.1 ms slowest with
the same 6 text reads; the initial baseline measured 2.5 ms median. The table
records the final sequential before/after run. These are small local DOM costs,
not end-to-end model response latency or a claim that all pages are six times
faster. Hardware load, DOM shape, browser engine, and page behavior affect
results. The byte-compaction
fixture continues to produce 235 bytes versus its 356-byte uncompacted form.

## Reproduce and validation

- `pnpm test:browser-agent`: eleven real Chromium DOM regression cases. Ten
  reproduced failures on the original source; disconnected-ref rejection already
  worked and remains covered. Navigation is included.
- `pnpm test:browser-agent --baseline`: run the same fixture against `HEAD`'s
  injected script, recording failures without treating them as test errors.
  This comparison requires a checkout where `HEAD` predates these changes.
- `cargo test --locked -p gyro-core openai_compatible -- --test-threads=4`:
  59 passed, including two added regression tests that failed before the repair.
  HTTP cases use local mock servers, not remote providers.
- `cargo test --locked -p gyro-core --lib provider_retry`: 15 passed.
- `cargo test --locked -p gyro-desktop --lib session_browser::tests`: 11 passed;
  the desktop test target compiled successfully, with existing dead-code warnings.
- An isolated, nonpersistent `WKWebView` ran the first ten DOM regression
  expressions against the same HTML and extracted agent: all ten passed. This
  used an ad hoc Swift runner; navigation remains covered in Chromium. The
  native app's smoke harness also contains subtree-ref, form-label lookup, and
  invalid-select regression steps, but that full app harness was not run here.
- Provider stream chronology and retry dispatch, browser pointer feedback,
  observation compaction, and browser capability checks passed.

The browser runtime check starts a disposable profile, uses an in-memory local
fixture, and removes the profile afterward. `GYRO_CAPTURE_BROWSER` selects a
different Chromium executable. The test needs local debugging sockets and
permission to launch the browser.

Raw fixture results and timings are in
[`2026-11-07-tool-reliability.json`](2026-11-07-tool-reliability.json).

The direct WebKit checks validate DOM-agent behavior, not the full Tauri
application and its callback plumbing. Live-provider tool success rates,
first-token latency, full app acceptance, and clean-machine release acceptance
remain unmeasured. Those comparisons remain necessary before making a
competitive performance claim or declaring the broader optimization goal
complete.
