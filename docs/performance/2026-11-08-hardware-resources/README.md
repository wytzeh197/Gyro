# Hardware resource audit — 8 November 2026

Gyro's main native process is only part of its resource cost. Count its WebKit
renderers, GPU/network helpers, provider runtimes and user commands as well.
This change removes avoidable background work without changing model selection,
reasoning effort, context limits, tool results, terminal history or visual quality.

## Native measurements

Machine: Macmini9,1, 8 GiB RAM, 8 logical CPUs, macOS 26.2 (25C56).
Installed app: `/Users/wytze/Applications/Gyro.app`, version 0.1.1, approximately
103 MiB on disk. Installed executable SHA-256:
`724006639ae0d19ff4670cb6c14a1335c5cbfab60507d4f08973169b8855d926`.
This identifies a local installed build, not a verified public release.

The [aggregate storage check](installed-storage.json) found approximately
1.33 GiB in the user's Gyro data directory: a 1.16 GiB SQLite database, about
159 MiB of session files, and smaller worktree/capture/spill files. Only 214
database pages were free (856 KiB at 4 KiB/page, about 0.07% of the database).
Routine compaction would recover very little. No history or user data was removed.

The 60.01-second [working-session sample](installed-working-session.json) includes
only processes attributed to Gyro by macOS responsibility, including XPC helpers
whose parent PID is launchd. CPU is computed from cumulative user/system CPU
time deltas, with Mach ticks converted using this machine's timebase. 100% means
one logical core, so a process group can exceed 100%.

| Observed metric | Result |
| --- | ---: |
| Entire attributed group, median physical footprint | 575 MiB |
| Entire group, sampled footprint range | 357–771 MiB |
| Entire group, average CPU | 24.46% of one core |
| Equivalent share of eight logical CPUs | 3.06% |
| Main native process, median footprint | 48.8 MiB |
| Main WebKit renderer, median footprint | 247.9 MiB |
| Second WebKit renderer, median footprint | 43.1 MiB |
| WebKit GPU helper, median footprint | 33.4 MiB |
| WebKit network helper, median footprint | 7.6 MiB |
| Group physical disk reads / writes | 332.8 MiB / 0.79 MiB |

Individual medians do not sum to the group median. Other attributed services
and transient runtime processes also contribute. Some transient runtimes used
approximately 176 MiB each. Their precise trigger was not established.

**This is not an idle benchmark or a before/after hardware comparison.** The app
showed an empty composer during the first observation, but the user's workload
changed and a later native inspection showed active split chats. The original
sample label is retained in the JSON with an explicit correction. An earlier,
short `top` observation showed about 41 MiB for the native process and about
0.1% CPU, illustrating why a single instant is inadequate.

This Mac was also heavily loaded by other work: load average was 26.2 at the
start of sampling, and system snapshots showed substantial memory compression
and paging. A separate read-only process inventory found 263 unrelated probe
processes using about 1.55 GiB RSS. They were excluded by ownership and left
untouched. These conditions prevent a representative latency, battery or
clean-machine idle claim. Physical disk reads may include paging/refaults;
they do not establish that Gyro read that much project data.

## Changes and measured work reduction

The [before/after fixture](scheduling-before-after.json) executes the actual
production hooks. It uses controlled document visibility and stub native
transports; these are operation counts, not estimated CPU or RAM savings.
The baseline is `35ef4814b13c1f9dfa2b9a0b93d0d25d2760dd68`; the five affected
frontend production modules were unchanged at the start of this task.

| Controlled scenario | Before | After |
| --- | ---: | ---: |
| Usage RPCs across 20 config renders with identical account membership | 20 | 1 |
| State changes on an identical cached usage poll | 2 | 0 |
| Optional account RPCs across 60 unfocused polling ticks | 60 | 0 |
| Explorer polling timers with all folders collapsed | 1 | 0 |
| Language polling timers with no eligible editor documents | 1 | 0 |
| Requests for two slow language servers across 60 overlapping ticks | 120 | 2 |

Implemented behavior:

- Account polling depends on account membership, not new config-array identities.
  A repeated IPC response/broadcast preserves React state identity when every
  displayed field is unchanged. A changed percentage, label, reset, status,
  timestamp, error or staleness still updates the display.
- Periodic account/ledger reads run in a focused, visible, online window. Focus
  refreshes immediately. Explicit reads and the existing live/post-turn updates
  remain independent, including during background agent work.
- An empty editor and a collapsed explorer no longer retain their one-second
  and two-second polling intervals. This removes 90 scheduled JS callbacks per
  minute in that state; it is not a measurement of 90 hardware wakeups.
- Hidden explorer invalidations defer directory reads until visibility returns.
  In-flight changes still coalesce into a follow-up read. Folder deletion,
  project switching, errors and unmount cleanup retain their existing handling.
- Each language server shares an unfinished diagnostics poll. A slow server
  cannot accumulate a new native request every second, and another server stays
  independent. Success and failure both release the guard; replies after disposal
  cannot publish retired diagnostics. Eligible documents retain live polling.
- On Unix, the native agent listener waits on socket readiness and a private
  shutdown socket. Its former 20 ms idle accept loop woke roughly 50 times a
  second. Shutdown signals the private socket and joins the thread; incoming
  clients do not wait for a timer. Loopback binding, authentication, the eight
  concurrent-client limit, request handling and approvals remain in the same
  path. The non-Unix fallback retains its existing behavior.

The fixes avoid unnecessary work rather than reducing task capability. They do
not prove a particular percentage reduction in total native RAM or CPU.

## Controlled native listener comparison

The [comparison](native-comparison.json) uses two 60-second empty-workspace
samples on the same Mac, with the same production frontend bundle and isolated
store, a fully painted 1280 × 820 composer, no folder/editor, and no connected
provider or model turn. Both executables are debug builds, with optimized
dependencies and unoptimized Gyro code. The frontend scheduling changes were
already present in the **before** build; this pair checks the native listener.
The [before manifest](isolated-build-manifest.json) and
[after manifest](isolated-after-build-manifest.json) pin the executables/assets.

| Metric | Before listener change | After |
| --- | ---: | ---: |
| Main-process interrupt wakeups/second | 46.91 | 4.55 |
| Attributed-group interrupt wakeups/second | 64.83 | 6.57 |
| Main-process CPU, % of one core | 1.28% | 0.76% |
| Attributed-group CPU, % of one core | 1.73% | 0.97% |
| Main-process median physical footprint | 36.1 MiB | 34.3 MiB |
| Attributed-group median physical footprint | 222.5 MiB | 261.6 MiB |

The main process recorded **90.3% fewer interrupt wakeups** in this pair.
A [post-measurement stack excerpt](listener-after-stack-excerpt.txt) confirms
the actual `gyro-agent-mcp` thread was parked in the new `poll` readiness wait.
It no longer has a 20 ms idle timeout. Both samples had zero counter-read errors.

**No total-RAM reduction is established.** The second process group held more
memory in WebKit and OS helpers: an additional Safari support process, different
Metal compiler-helper residency, and a larger main renderer. The main native
process itself was slightly smaller. These are measured observations, not proof
of a lasting memory improvement or regression. Host load also changed from 19.4
to 11.5; use repeated release-build trials on a quiet Mac before generalizing the
CPU percentages. Interrupt-wakeup counts are not a battery-life measurement.

The initial incomplete-paint sample is retained as
[excluded evidence](isolated-initial-paint.json); raising/resizing the window
produced the complete composer before the accepted samples. A quit-state UI
check also relaunched an old process; its launch timestamp exposed that mistake,
and it was stopped before the fresh after-process was launched. It supplied no
after measurement. The accepted roots are PID 80487 before and PID 11418 after.
Process inspection after quitting found no remaining attributed processes for
[either](isolated-baseline-exit.json) [measured root](isolated-after-exit.json).
All disposable review instances were closed; the installed app was not replaced.

One restart displayed an automation-load notification. The Automations view
subsequently opened without another notification; a complete scheduler lifecycle
was not exercised. This is a resource probe of a shared, changing checkout,
not a claim of full native release acceptance.

## Reproduce and protect

Run the behavioral checks without provider calls:

```sh
node scripts/check-resource-scheduling.mjs
node scripts/check-editor-language-sessions.mjs
node scripts/check-page-reliability.mjs
node --experimental-strip-types scripts/check-workspace-explorer-refresh.mjs
node --experimental-strip-types scripts/check-workspace-explorer.mjs
node --experimental-strip-types scripts/check-composer-context-usage.mjs
CARGO_BUILD_JOBS=2 cargo test --offline --locked -p gyro-core --lib \
  agent_sessions::tests -- --test-threads=2
```

The new scheduling guard is also included in `test:reliability` and the guard
registry. For a comparison against the original production modules:

```sh
node scripts/check-resource-scheduling.mjs \
  --baseline 35ef4814b13c1f9dfa2b9a0b93d0d25d2760dd68 \
  --output /private/tmp/gyro-resource-scheduling.json
```

To measure a running native app, identify its main PID and describe the workload
accurately. The sampler does not start a model turn, modify the app or upload data:

```sh
python3 scripts/measure-native-resources.py --pid PID --seconds 60 \
  --label 'Describe window state, open surfaces and actual running work' \
  --output /private/tmp/gyro-native-resources.json
```

The sampler saves executable basenames and counters, not arguments, credentials,
project paths or transcript contents. Process inspection permission is required.
It uses a private macOS responsibility API only in the opt-in diagnostic script;
the shipping app gains no sampler, background collector or dependency. If that
API is unavailable, the script fails instead of counting unrelated WebKit tasks.
The public usage structure follows the local SDK's `sys/resource.h`; the API
wrapper is visible in [Apple's XNU source](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c).
A local CPU calibration measured 0.200061 seconds from Mach counters against
0.200002 seconds from Python's process clock, a ratio of 1.00030.

Sampling misses very short-lived processes between observations and their final
counters after exit. Physical footprint includes compressed memory but is not an
exclusive allocation trace. GPU watts, network traffic and external local model
servers are not included unless separately measured. Run each scenario several
times on a quiet Mac before setting release budgets.

## Validation and remaining acceptance

Passed: production frontend and native debug builds; desktop TypeScript check; scheduling guard;
14 language-session behaviors; provider snapshot ordering and identity; page
recovery/polling lifecycle; explorer lifecycle/listings; terminal output; history
efficiency; and guard-registry coverage. These tests include failure recovery,
background explicit refresh, foreground catch-up, changed usage fields and
disposal of late replies. All 32 agent-session Rust tests passed, including
quiet shutdown, readiness/shutdown wake signals, authentication, concurrent
clients, revocation, session cancellation and approvals. No paid provider
benchmark was initiated.

Design-system review, limited to these internals: no tokens, CSS, components,
copy, layout, controls or keyboard bindings were changed. State freshness and
hidden/visible transitions passed behavioral checks. The isolated native empty
composer was visually inspected before and after the listener change. A complete
accessibility and live-provider review is not established by those checks.

The installed working-session data above must never be presented as a performance
improvement from these edits. These changes were not installed over the user's
app, and unrelated working changes were preserved.

Release acceptance should cover a quiet idle composer, hidden window, long chat
stream, one/four split chats, terminal output and exit, editor diagnostics,
browser page ownership, large review, and return to idle after closing each
surface. Use the same store/workload/build profile before and after. Confirm
usable-composer and interaction latency as well as CPU, physical footprint,
child-process count and memory recovery; a small footprint alone is insufficient.

Follow-up: the [editor retention audit](../2026-11-08-editor-retention/README.md)
reproduces and fixes buffer/model accumulation when replacing clean previews.
