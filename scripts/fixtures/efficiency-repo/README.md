# Frozen Gyro cost/quality pilot

This pack tests whether cost optimizations preserve useful behavior on extracted
Gyro code. It contains deliberately seeded regressions in six frozen local
modules, not verified historical production bugs or a full app build.

`provenance.json` identifies the exact source bytes, the checkout HEAD, and whether
each file was committed, modified, or untracked when copied. Generation reads only
these frozen copies. Changes elsewhere in the working tree do not change a task.

| Task                           | Work                              | Independent checks                                                                                                             |
| ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `gyro-retry-terminal-guards`   | Repair retry eligibility          | Terminal stops, useful transient retries, history, duplicate frames, busy sessions, completed work                             |
| `gyro-usage-confidence`        | Repair two usage-display modules  | Unknown versus measured counts, partial lower bounds, reported subtotals, valid zero, inclusive cache/reasoning                |
| `gyro-search-session-recovery` | Six-turn concurrent search repair | Early publication, workspace ordering, global cap, stale success/error suppression, partial failure, earlier evidence recovery |

The long-session task includes two generated diagnostic captures of about 55 KB
each. These are fixture rows, not user data. Its final summary checks exact facts
from the middle of the first capture. The source capture remains available, so a
model may correctly recover by rereading the file. This deliberately avoids
requiring a particular model tool strategy.

## Validate or regenerate

Requires Node 24+; no package installation, provider credential, or app build:

```sh
node scripts/check-efficiency-repo-pilot.mjs
# After an intentional fixture/verifier edit:
node scripts/check-efficiency-repo-pilot.mjs --write
```

The checker verifies source hashes, deterministic manifest generation, task
snapshots, path scope, runnable public smoke checks, behavioral baseline failures,
passing reference solutions, and rejection of incomplete/over-broad repairs.
Independent verifiers run outside each model workspace. They assert behavior,
not matching source text. This is test separation, not a security sandbox against
a malicious model that can read arbitrary host paths.

The generated spec is `docs/performance/efficiency-repo-pilot.json` and uses the
existing strict `gyro.efficiency-benchmark.v2` runner. The offline evidence is
`docs/performance/efficiency-repo-validation.json`. This validation makes **no
provider, cost-saving, native-app, or compaction-quality claim**.

## Bounded live comparison

The checked-in spec cannot run paid calls: providers and prices are empty, and
call/token budgets are zero. A live copy needs one provider/model with an explicit
requested reasoning effort, a current immutable price snapshot where required,
and approved finite call, token, and cost ceilings. Use the existing runner:

```sh
node scripts/benchmark-efficiency.mjs --spec /absolute/path/to/approved-live-copy.json
```

Default comparison: baseline, recoverable-evidence, and cache-assembly separately;
three trials; fresh and resumed sessions. That is 54 task runs and up to 171 user
prompts including resumed-session setup, before tool-loop requests and retries.
These are planning counts, not costs or a sufficient call budget. Reduce the
matrix explicitly for an initial capped probe; never silently omit failed runs.

Use the existing report gates: complete matched cohorts, verified outcomes,
comparable requested effort, complete provider usage and retry/timing coverage,
matching currency, and pinned prices. Evaluate cost per verified task, failures,
and latency together. Fresh/resumed session labels do not establish cold/warm
provider caches. Do not promote experimental defaults from this small pack alone.

A successful long task proves its final behavior and recovered facts. It only
counts as **observed spill recovery** when the task receipt has complete
`efficiencyEventCoverage` and a positive `efficiencyEvents.spillRecoveries` count.
If those are missing or zero, report recovery-path coverage as unobserved and
adjust the next bounded probe. Compaction acceptance needs separate explicit
compaction evidence; a long transcript or a shorter payload does not establish it.
