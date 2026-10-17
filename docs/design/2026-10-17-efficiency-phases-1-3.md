# Token-efficiency implementation: Phases 1-3 engine

Status of the phases in [2026-10-17-deepseek-harness-gap-analysis.md](2026-10-17-deepseek-harness-gap-analysis.md), after the engine work landed.

## Landed and tested

| Module | Phase | What it does |
|---|---|---|
| `efficiency/spill.rs` | 1 | Head/tail preview + stable `spill://` address + retrieval hint, a durable, atomically written store with `gc`, and a bounded reader (`read`/`read_window`) behind `gyro spill` |
| `efficiency/compaction.rs` | 2 | Anchor-preserving compaction with before/after accounting; never orphans a tool result |
| `efficiency/cache_plan.rs` | 3 | Per-route prefix-cache plan: explicit vs implicit vs none, prefix digest, and prefix-stability measurement |
| `efficiency/accounting.rs` | 0 | Retired-byte ledger: `Attribution.retired_bytes` → `attribution_json` → `TaskTotals.retired_bytes` |

`cargo test -p gyro-core efficiency::` — 59 passed, 0 failed.

## Wired into the live path

`efficiency/context.rs::slim_data` no longer drops retired tool text outright. A payload over
`spill::SPILL_MIN_BYTES` (2 200 bytes) keeps a bounded preview (1 200 head + 600 tail), gains a
`spill` address, an `elidedBytes` count and, when the payload names a path, a `retrievalHint` with the
exact line range to re-read. This is the behaviour change the phase was for: recovering retired
evidence no longer requires a second full read.

Four tests in `context.rs` encoded the old "content must be absent" contract and were updated to the
new one: retired evidence is **bounded**, not deleted, and always names its full copy.

## Design decisions worth keeping

* **Nothing added per model.** No added model call, no extra round trip, no per-model price table.
  Every mechanism is local computation, so cost improves uniformly across providers.
* **No new wire fields.** `cache_plan` only sets `prompt_cache_key` / `prompt_cache_options` for
  `api.openai.com`, matching today's behaviour exactly. Hosts with automatic prefix caching
  (`api.deepseek.com`, `api.mistral.ai`, `generativelanguage.googleapis.com`) are marked `Implicit`:
  they need no field, and the cost driver there is *our own* prefix churn, which
  `cache_plan::stable_prefix_len` / `appended_only` now make measurable.
* **Dependency-free hashing.** Spill addresses use FNV-1a; a hash here is an identifier, not a
  security boundary. `cache_plan` reuses the existing `sha2` dependency for the cache key.

## Phase 0 ledger (landed)

Retirement savings were computed and then thrown away. They now reach the accounting store:

1. `context::Attribution` gains `retired_bytes` (serialized `retiredBytes`) with `#[serde(default)]`,
   so `attribution_json` rows written before the field existed still deserialize.
2. `prepare_owned_model_request` already returned the byte count; both runners
   (`openai_compatible_runner.rs`, `ollama_runner.rs`) now hand it to
   `provider_observation::retired_context`, which accumulates it on the active summary.
3. `provider_observation::categorize_prompt` copies the field onto the attribution that is actually
   persisted, so the number survives the re-derivation of prompt categories from the sent payload.
4. `accounting::totals` reads `attribution_json` and sums `retiredBytes` into
   `TaskTotals::retired_bytes`, so a task can report what its own context shaping saved.

Verified: `cargo test -p gyro-core efficiency::` — 54 passed, 0 failed, including
`accounting::tests::retired_bytes_survive_the_call_metadata_round_trip`.

## Phase 3 — landed, with the cache left warm

`cache_plan` now owns the OpenAI derivation and `cache::apply` is a thin applier:

- `cache_plan::openai_prefix_key` produces exactly the bytes `cache.rs` used to build inline —
  `gyro:` plus the SHA-256 of `{"instructions": <system|developer messages>, "tools": <schema>}`.
- `cache_plan::openai_cache_options` matches the same model prefixes (`gpt-5.6`, `gpt-6`).
- `cache::apply` keeps one gate (enabled, https, `KEY_HOSTS`) and otherwise only calls those two.

The key was **not** changed. `cache_plan::digest` — salted, 32 hex — is a different artefact for local
bookkeeping and is not the wire key; reusing it for `prompt_cache_key` would have invalidated every
cache the fleet holds. The wire key stayed byte-identical, and
`key_is_byte_identical_to_the_legacy_derivation` fails loudly if that ever drifts.

## SpillStore — adopted, and what it still does not fix

`spill::persist` writes the full copy before the preview quotes the address, resolving the store from
`GYRO_SPILL_DIR` or the app data directory, sweeping to `SPILL_KEEP` every 64 writes. Verified by
pointing `GYRO_SPILL_DIR` at a temp directory and confirming files appear.

The address is now dereferenceable, which is what the earlier warning in this document asked for: the
store was adopted only alongside a read path, and that path now exists.

`spill::read` / `spill::read_window` resolve an address to a bounded, character-aligned window of the
stored copy, and `SpillRead::render` stamps the readback with the address, the byte range and the next
offset, so a second read is a number to copy rather than arithmetic. Three properties are the point:

- **Bounded.** `SPILL_READ_WINDOW` (8 KiB) is the default and the CLI caps a request at 64 KiB. A
  reader that returned everything would undo the saving the address exists to serve.
- **Absence is not failure.** `Ok(None)` means evicted by the sweep or never written; a string that is
  not a `spill://` address is refused as `InvalidInput`, so a typo never reads as "gone".
- **Offsets are boundaries.** A window that lands mid-character widens to the boundary instead of
  splitting it, so every readback is valid UTF-8.

`gyro spill <address> [--offset N] [--limit N] [--json]` is the consumer, which is what keeps the
reader from being dead code: exit 2 for a malformed address, exit 5 for an absent copy, and the same
renderer for humans.

What is still missing is not a reader but a reader *the model can call*. The model sees the preview and
`retrievalHint` (`path`/`line`/`endLine`); its tools belong to the app, not to core. Letting a model
open an address needs a tool in the app's tool loop that calls `spill::read_window`. Until that lands,
the address is true on disk and readable by a human or a shell, and the actionable instruction for the
model remains `retrievalHint`.

## Phase 2 — deliberately not wired

`provider_context::auto_compact_messages` is *richer* than `compaction::compact`, not a copy of it: it
splits on exchanges, elides only whole tool-call exchanges, refuses to compact when the oldest exchange
holds an image it would have to drop, and replaces a previous auto-note in place. Calling the generic
`compact()` there would lose all four behaviours.

So `compaction::compact` stays off the wire path on purpose. It remains the provider-agnostic fallback
for a route that builds its own message list outside the desktop loop. If no such route appears,
deleting it is a better end state than wiring it in.

## Closed: the model-facing spill reader

`gyro_workspace_read` now resolves a `spill://` address itself. `workspace_capability_read::read_spill`
calls `spill::read_window` with the advertised `offset` and a 64 KiB window cap, and reports the same
numbers `gyro spill` prints — `bytes a–b of N · next offset=K` — so the next read is a number to copy
rather than arithmetic. The address skips path normalization, the IDE buffer lookup and the file
guard: the copy was disclosed by the read that produced it, so there is no file left to authorize. An
address with no copy reports absence ("swept, or never written") instead of a workspace miss, so a
swept copy never reads as a typo.

`retrievalHint` is now a convenience rather than the only route to the full text.

## Still open

1. **`compaction::compact`** stays off the wire path on purpose (above). If no route ends up building
   its own message list, deleting it is a better end state than wiring it in.

## The three failing tests

Two were stale assertions, one was a load-sensitive bound. None involved product behaviour changing
under them.

- `tool_activity_uses_kind_and_path_when_title_is_missing` and
  `unlabeled_tool_activity_uses_the_provider_label` asserted on `activities[0]`. The concurrent UI work
  publishes a live `context-usage` row while traffic is estimated, so that row lands at index 0 and the
  tool call moved down. Both now find the tool activity (by id, and by kind) instead of assuming a
  position; the assertions themselves are unchanged.
- `kimi_code_cancellation_during_local_usage_query_never_starts_generation` bounded cancellation at 2s.
  Isolated it returns in ~0.2s, and the whole `kimi_acp` module passes in ~6s — but a full-suite run on
  a contended machine blew past 2s on scheduling alone. The bound is now 4s, which still proves
  cancellation does not wait for the 6s usage-query timeout. Stated plainly: this is a loosened
  threshold, chosen so the test measures behaviour rather than machine load; a regression that blocked
  on the query would still fail it.

## Verification

- `cargo test -p gyro-core` — **685 passed, 0 failed**.
- `cargo check -p gyro-cli` — clean.
- Live: `gyro spill src/lib.rs` → exit 2, `not a spill address`; `gyro spill spill://a/b/c` → exit 5,
  absent copy; `--json` returns the versioned envelope.
- Caveat worth keeping: this suite has load-sensitive socket tests outside these modules.
  `openai_compatible::tests::openrouter_receipt_*` failed once with `WouldBlock` under full parallelism,
  then passed in isolation and on the next full run. A green run here is green on an uncontented
  machine, not proof that every test is load-proof.

