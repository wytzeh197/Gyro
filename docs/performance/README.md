# Execution evidence and Gyro design study

This milestone adds opt-in timing diagnostics, a reproducible provider benchmark,
and an isolated visual prototype. Provider sign-ins, integrations, production
navigation, panel placement, and execution policy retain their existing behavior.

See the [measured report](2026-09-11/report.md), [raw summary](2026-09-11/measurements.json),
and [design specification](design-language.md).

## Open the interactive prototype

From the repository root:

```sh
CI=1 pnpm --filter @gyro-dev/desktop exec vite --host 127.0.0.1 --port 1432
```

Open `http://127.0.0.1:1432/prototype.html`. It is a separate development entry,
not a production route. Select any of seven states, light/dark, or 120 history
entries. Try streaming, type a draft, scroll, resize the companion divider with
the pointer or arrow keys, and press Stop. Review, Terminal, Files, and Browser
remain in their current companion positions. All displayed work and test results
are explicitly sample data. Sidebar actions demonstrate selection; this is not
a replacement for the complete application.

## Enable local timing

Launch a fresh checkout process with `GYRO_TIMING_DIAGNOSTICS=1` in its environment.
Omitting the variable disables the collector and diagnostic writes. The frontend
queries the setting once at mount. A running process must be restarted to change it.

Records are saved under Gyro's `logs/timings/` directory, normally
`~/Library/Application Support/Gyro/logs/timings/`. Directory permissions are 0700
and files 0600 on macOS. Records are never uploaded. Delete that directory to
remove them; this first version has no automatic retention policy.

Backend traces contain only schema, random trace/session/turn identifiers,
bounded monotonic durations, enumerated stages/outcomes, attempt counters, and
numeric tool indexes. No prompts, paths, commands, tool arguments, model output,
or error text enter their wire format. Frontend records accept only a turn UUID
and four bounded numeric durations; unknown fields are rejected. Each backend
trace is capped at 4,096 points; the frontend retains at most 128 turns.

Stage semantics:

| Measurement                  | Meaning                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| Send → invoke                | Accepted send through frontend preparation to native invocation      |
| Backend received             | Start of the blocking provider worker; native queue time precedes it |
| Workspace                    | Capability context/workspace preparation before “started”            |
| Process start → spawned      | Subprocess creation, excluding protocol initialization               |
| Spawned → protocol ready     | Runtime initialization and new/resumed session readiness             |
| Prompt sent → first activity | First useful emitted activity, excluding heartbeats                  |
| Tool start/end               | Provider tool boundaries; overlaps must be merged for wall time      |
| Approval start/end           | Each synchronous approval wait on the provider worker                |
| Provider complete → complete | Usage/result persistence and final desktop response work             |
| Received → paint opportunity | Accepted ordered event, React commit, then two animation frames      |
| Send → settled               | Native command resolution or rejection                               |

The frontend measurement is a paint opportunity, not a hardware presentation
timestamp. Hidden documents are unmeasured. Side-chat sends record invocation and
settlement but do not yet have a separate committed-render probe. Legacy calls
without a turn ID are not given fabricated timing identities. Council aggregation
and CLI-only runs are outside the desktop Send measurement. ACP subprocesses
produce protocol/tool timing when called by a traced desktop worker.

Traces flush at worker exit. A hard process kill can leave no final timing file;
the session event ledger and startup reconciliation are the evidence for that case.
The collector reports persistence failures without failing the provider request.
The synchronous approval hook does not cover every asynchronous capability-server
approval path; those events remain in the existing capability ledger.

## Reproduce the provider matrix

This command makes real provider calls through existing CLI sign-ins and may use
paid usage. It creates a disposable store and fixture repositories:

```sh
node scripts/benchmark-providers.mjs --spec docs/performance/benchmark-spec.json
```

The spec fixes model/effort, five fresh and five resumed trials per task, and a
150-second deadline per turn. Three provider workers can run concurrently, with
sequential trials within each provider. A resumed measurement excludes its
read-only bootstrap turn. Authentication/model/executable failures mark later
slots unavailable. Each completed trial is checkpointed. To resume an interrupted
matrix, pass `--resume` with the printed temporary root and the same spec.

The debug-only native entry uses the actual desktop `run_provider_chat` command,
store, capability bridge, cancellation manager, and provider adapter. It uses
`GYRO_TEST_DATA_DIR`, requires a temporary root, requests automatic native file edits
and allows local terminal commands in its fixtures, and denies browser/GitHub access there.
Explicit Workspace edit proposals still enter Gyro's separate review flow, even
with the native file-approval flag off. The benchmark does not silently approve
those proposals or count an unapplied proposal as a correct output.
Fixture instructions forbid network, installation, commits, pushes, and delegation.
The isolated usage guard stays enabled with a finite 200-call window allowance
for the planned matrix, bootstrap turns, and recovery attempts. Normal user
configuration and the normal Gyro socket are not rewritten.

```sh
node scripts/summarize-provider-benchmark.mjs TEMPORARY_ROOT OUTPUT_DIRECTORY
```

The summarizer exports content-free measurements and traces. It excludes the
initial rate-guard setup mistake, preserves real failures and incorrect results,
and distinguishes unavailable providers. The underlying disposable session logs
contain ordinary provider transcripts; they are not the privacy-limited timing
format and are not copied into the report.

## Verification commands

```sh
node scripts/check-turn-timing.mjs
cargo test -p gyro-core timing::tests --lib
cargo test -p gyro-desktop retry_fault_evidence --lib -- --nocapture
CI=1 pnpm test:reliability
CI=1 pnpm typecheck
CI=1 pnpm --filter @gyro-dev/desktop build
cargo test --workspace
```

The retry fault probe characterizes current behavior, including a known duplicate
mutation after a disconnect. A passing probe means the evidence was reproduced;
it does not mean that behavior is safe. See the dated report for the finding.
