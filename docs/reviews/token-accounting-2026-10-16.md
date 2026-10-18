# Chat token accuracy — 16 October 2026

Chat token counts now display provider observations: exact reported totals,
`≥` observed lower bounds when coverage is incomplete, or “Usage unavailable.”
Text estimates, mixed estimates, contradictory counts and unverified historical
numbers do not display their numeric total in chat. When a separate trustworthy
provider subtotal exists, the session can show that observed lower bound.
Reported zero remains zero.
Composer context estimates and conservative budget accounting remain separate.

## Confirmed defect and native evidence

A read-only audit of the current local store found 33 recent Codex receipts:
32 provider receipts reconcile with the six corresponding native rollouts across
input, cached input, output, reasoning and total. One cancelled turn had stored
a character estimate of **768**, although its exact native turn recorded
**278,200** tokens. The saved terminal event and ledger agreed with each other,
so checking only the two Gyro copies would have missed the error.

The native cumulative baseline was 65,742,659; the ending counter was
66,020,859. The delta is 278,057 input + 143 output, including 276,608 cached
input and zero reasoning output. Cache and reasoning are subsets, not additions.
The token record preceded the matching `turn_aborted` by 14 ms.

The new bounded recovery reader was compiled and replayed against that actual
native file and returned the ending counters yielding **278,200**. A regression
fixture reproduces the same identity, baseline and counter sequence through
`CodexTurnUsage`. User data was not modified, and no new model generation was
performed for this audit.

## Implemented repairs

- Codex retains already observed request usage when a resumed update omits its
  last-request reading. Error/cancellation finalization preserves observed
  consumption and marks incomplete coverage.
- After the app-server stops, recovery reads a bounded tail of its exact
  provider-returned rollout. Both the thread header and requested native turn
  boundary/terminal identity must match. Cumulative counters use the established
  pre-dispatch baseline; absent baselines remain partial. Repeated recovery
  replaces the observation rather than adding another charge.
- HTTP and Ollama partial receipts retain actual reported buckets instead of
  filling missing halves with character guesses. Ollama no longer invents a
  reasoning-token breakdown from thinking text; its reported prompt/output
  totals remain authoritative without a separate reasoning count.
- The exact Kimi Code CLI 0.37.2 / ACP protocol 1 runtime can obtain a main-agent
  lower bound through private local `/usage` snapshots before and after the
  prompt. Session totals are differenced on the same session; the result stays
  partial because native child sessions have separate counters. Unknown
  versions and legacy behavior do not qualify. The command path was checked
  against [the pinned Kimi implementation](https://github.com/MoonshotAI/kimi-code/blob/c41fadf0f78b35ecaf3d613ca26580a9a093de80/packages/acp-server/src/builtin-commands.ts).
  Metadata reports do not enter the transcript or add model generations. A
  failed post-query preserves the answer, and a pre-query timeout reopens the
  connection before any real prompt so late metadata cannot contaminate it.
- Session receipts include exact linked descendant turns once, excluding other
  history in reused child sessions. Missing dispatched-call receipts downgrade
  both token receipts and session summaries. Unknown calls do not invent zero
  consumption or an origin.
- Canonical final receipts outrank stale optimistic checkpoints independently
  of merged array order. A newer canonical correction can still replace the
  final reading. Active turns continue accepting live readings after
  intermediate durable checkpoints. Partial provider buckets remain usable
  without invented zero breakdowns.
- Completed agent cards accept verified ledger session consumption and label
  it explicitly as cumulative `tokens total`. Turn badges still reject raw
  provider session counters as turn consumption.
- Live context occupancy survives a closing response that has no usable
  occupancy. Switching to a smaller model does not erase the previous model's
  observed context.

## Verification

- Core library: 633 tests passed.
- Desktop library: an initial full run passed 705 tests with six existing tests
  ignored. The final concurrent run passed 704 and hit one unrelated Git-status
  deadline assertion; that test passed unchanged when rerun alone. The token
  accounting tests passed in both runs.
- Standalone CLI: 66 tests passed (40 unit, 25 exit-code integration, one macOS
  installation-path integration).
- Kimi's nine focused regressions cover exact runtime/report guards, observed
  zero and cumulative deltas, one real prompt despite metadata queries,
  metadata errors/timeouts, exact fresh/resumed prompt preservation, failed
  session reopen, context updates and cancellation.
- Token display, session ledger, composer context, live model context and
  provider stream ordering regression scripts passed.
- Shared UI TypeScript check passed. Desktop TypeScript passed with
  `--composite false --rootDir .`; the normal workspace command still fails
  existing TS6059/TS6307 cross-package `rootDir`/composite configuration errors.
  Its configuration is unchanged by this work.
- The actual `ChatSurface` browser fixture verified provider zero, partial,
  unavailable, cache/reasoning, historical estimate, stale checkpoint and late
  canonical correction states. A stale 9,000 checkpoint leaves the final
  1,540 count intact; a system-only correction changes it to 2,000. Completed
  agent cards render verified cumulative consumption as `3,300 tokens total`.
- The architecture checker still fails the unchanged `App.tsx`: HEAD already
  has 20,338 lines against its 20,329 ceiling. `surfaces.tsx` was also already
  above its ceiling (29,936 vs 29,926); this change adds two integration lines
  and keeps token selection in a separate helper. The native integration
  remains below its existing ceiling (31,202 vs 31,217).

Browser fixtures use synthetic data; they are not new native-provider acceptance.
The native replay verifies an existing real receipt rather than spending on a
new generation. No installed app replacement, publication, or historical ledger
rewrite was performed.

## Conservative limits

Native recovery refuses logs without a matching turn boundary and terminal
record in its 2 MiB tail, mismatched identities, missing native turn IDs, or
incomplete writer output. It preserves available stream observations instead
of guessing ownership or a new counter epoch. Runtimes without a verified
consumption contract remain unavailable or show an observed lower bound.
