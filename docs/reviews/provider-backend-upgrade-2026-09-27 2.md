# Provider backend upgrade implementation

Date: 2026-09-27
Starting checkout: `release/v0.1.0-alpha.49.7`, `70ad34c7`
Scope: subscription CLI/ACP adapters, desktop API chat, and local Ollama

## Review outcome

Implemented the source-confirmed defects and bounded improvements from the
[upgrade plan](../design/2026-09-27-provider-backend-upgrade-plan.md). The existing
provider protocols, model/effort selection, capability broker, context compaction,
usage guards, and session store remain the foundation. Unrelated browser and
appearance work in the checkout was preserved. No commit or release was made.

The plan's performance exits remain open until comparable live workloads have
been measured. The changes below have local regression evidence, not a measured
claim of lower provider bills or production latency.

## Changes

| Area | Implementation | Evidence / boundary |
| --- | --- | --- |
| Silent API/local requests | Pooled asynchronous generation transport behind the existing synchronous adapters; notification-based cancellation drops pending headers/body reads. A single shared runtime handles transport IO. | TCP mocks verify Stop returns within one second and closes both a silent pre-header request and a silent response body. Short discovery probes retain their existing bounded transport. |
| Retry amplification | HTTP retries, interrupted streams, and optional-field negotiation share three retries per generation request. Fallback backoff has jitter; explicit Retry-After stays authoritative. | Nested retry regression permits at most four sends. Completed tool rounds are outside the retry boundary. |
| Safe recovery | Stale-cursor retry requires no published output or dispatched broker call and no cancellation. Failed runs preserve the latest observed cursor. | Stale-cursor, stop, before-edit/after-edit disconnect, and cursor-persistence regressions. Vendor-native side effects with no observable event remain outside what Gyro can prove. |
| API compatibility | Only an explicit unsupported `stream_options` error can remove usage reporting. Successful negotiation is cached for 15 minutes in memory, bounded to 128 endpoint/model/credential identities. | Generic HTTP 400 does not retry. Selected reasoning effort and native tools survive usage negotiation. No credentials or response bodies are persisted in the cache. |
| Usage accounting | All observed HTTP rounds/attempts feed one turn total. Failed partial work and native restarts retain reported counts or clearly marked estimates. Cached input and reasoning detail are retained. | Counts are separate from the final request's context occupancy. Missing counts use assembled request text/schema plus observed output; image bytes are excluded. Estimates can err in either direction and are not hard spend ceilings. |
| Codex usage | Cumulative thread totals are converted into turn deltas with duplicate protection. `last` remains context occupancy. Updates must match the active provider thread and turn. | Fresh-turn and resumed-thread fixtures pass. A resumed thread without a pre-turn baseline is marked estimated; hidden earlier activity is not claimed as precisely measured. Protocol fields were checked against the installed app-server schema. |
| Native tools | API/Ollama native arguments use the advertised schema validator before broker execution. Contiguous independent workspace list/search/read/read-range calls run up to four at a time. | Results keep input order; writes, commands, editor reads, and browser actions remain barriers. Policy, scope, approval, and cancellation still run per call. Failed reader batches finish joining before returning. |
| Local startup | A send fetches the installed-model list and enriches only its selected model. Settings can still discover the full catalog. | Mock with three installed models observes two metadata requests and preserves selected-model context, tool, and image capabilities. No model prewarming or automatic model substitution. |
| Diagnostics | Existing opt-in timing gains first-text and HTTP request boundaries, numeric usage/retry summaries, and shared trace attachment for broker workers/approval waits. | Bounded content-free trace checks pass; protocol and broker tool spans stay distinct. Broker queue and local load durations still need separate measurements. |
| Benchmark reporting | Harness accepts executable built-in provider families, including API presets and Ollama. Summary reads dynamic provider files/spec slots and includes first token, observed usage, request counts, and sample p95. | Fixture checks cover API/local rows, retry reconciliation, tool overlap, and private content exclusion. No live matrix was run. |

An increase in displayed usage after this change can reflect previously omitted
tool rounds or retries. It must not be presented as an increase in model work
without comparing the actual provider requests.

## Main files

- `crates/gyro-core/src/chat_http.rs`: pooled cancellable transport.
- `crates/gyro-core/src/provider_retry.rs`, `api_compatibility.rs`: bounded retries and compatibility memory.
- `crates/gyro-core/src/provider_observation.rs`, `timing.rs`: numeric usage and timing collectors.
- `crates/gyro-core/src/openai_compatible.rs`, `ollama.rs`, `kimi_acp.rs`: adapter integration.
- `apps/desktop/src-tauri/src/provider_accounting.rs`: ledger integration, broker timing, Codex turn accounting.
- `apps/desktop/src-tauri/src/provider_tool_batch.rs`, `provider_reliability.rs`: read batching and argument validation.
- Desktop runners and `lib.rs`: adapter wiring and retry boundaries.
- `scripts/summarize-provider-benchmark.mjs`, `check-provider-benchmark-summary.mjs`: report support and fixtures.

## Verification

All calls below use local tests/fixtures. Live account and installed-provider
launch tests remain ignored.

| Command | Result |
| --- | --- |
| `cargo test -p gyro-core --lib --offline --quiet` | 401 passed |
| `cargo test -p gyro-desktop --lib provider --offline` | 65 passed, 4 ignored |
| `cargo test -p gyro-desktop --lib performance_benchmark::tests --offline` | 4 passed |
| `cargo test -p gyro-desktop --lib usage --offline` | 28 passed, 3 ignored; overlaps provider selection |
| `cargo test -p gyro-desktop --lib ollama --offline` | 1 passed; overlaps usage selection |
| `cargo test -p gyro-desktop --lib stale_resume --offline` | 2 passed |
| `cargo check -p gyro-desktop -p gyro-cli --offline` | Passed |
| `node scripts/check-provider-benchmark-summary.mjs` | Passed |
| `node scripts/check-architecture-boundaries.mjs` | Passed |
| `node --experimental-strip-types scripts/check-turn-tokens.mjs` | Passed |
| `node scripts/check-turn-timing.mjs` | Passed |
| `git diff --check` | Passed |

## Remaining measurement gates

1. Collect live fresh/resumed trials for one subscription adapter, one API preset,
   and one installed local model using the documented disposable harness. Keep
   model/effort and task cohorts stable. Add no-tool and cold/warm local trials;
   the existing harness covers three coding tasks.
2. Reconcile available provider receipts against turn totals, especially resumed
   Codex and failures. Verify cancellation against actual endpoints/CLIs, and
   inspect real approvals with concurrent reads in the native app.
3. Only after those results, consider provider/model admission queues, persistent
   CLI processes, prewarming, schema discovery, and additional prompt compaction.
   Require equal or better task success and fewer correction turns. Five trials
   provide a descriptive sample p95, not a reliable production tail estimate.
4. Standalone Gyro CLI API execution remains separately scoped; it can configure
   API providers but explicitly rejects API chat. Desktop API image support
   already existed and is now accurately documented.

These gates are deliberately visible in the plan. There is no evidence yet to
justify replacing the scheduler or enabling more aggressive context reduction.

## Follow-up verification and fixes

The follow-up review found and fixed four bounded weaknesses:

- **Broken HTTP error bodies lost the status.** A truncated or stalled error
  response could turn a permanent rejection into a retryable transport error.
  Error bodies now have a five-second total budget (or the shorter request
  budget), preserve the original status and Retry-After, and remain cancellable.
- **Partial usage could become stale.** Input/output counts now merge across
  separate usage frames. Missing counts are estimated when the request ends,
  using all text observed by then; late cache/reasoning details are retained.
- **Rejected requests fell through to a prompt estimate.** When all HTTP
  exchanges are rejected, the collector explicitly records zero observed
  generation tokens, marked unmeasured. Attempt/rate guards still count calls.
- **Single reads created unnecessary threads.** An isolated read now executes
  on the current worker. Independent groups still use the bounded parallel path
  and preserve write barriers and result order.

Verification: 61 focused tests passed across HTTP transport (including Stop
during error-body reads), partial usage, API/Ollama adapters, retries, desktop
accounting, and read batching. CLI compilation, architecture checks, benchmark
summary fixtures, and whitespace checks passed. No live provider or native UI
acceptance was added; the measurement gates above still apply.
