# GPT/Grok live workflow probe — 2026-11-07

The first live probe did **not** establish successful task completion or a model
ranking. Eight measured conditions produced one completed reply, zero verified
task completions, six cancelled task attempts, and one failed setup. Preserved
results are in [measurements.json](measurements.json) and
[results-table.md](results-table.md).

## Scope and runtime

Wytze authorized GPT/Grok for the proposed bounded probe: a README shortening
task and a clamp bug fix, each fresh and resumed, one trial per condition,
medium effort, and a 60-second cancellation deadline per turn. The models were
GPT-6.1 Sol through Codex CLI 0.152.1 and Grok 4.7 through Grok CLI 1.0.77.
GPT-6.1 Sol was present in the local model cache fetched the same day; its
[official model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
also documents the model ID. Grok 4.7 matched the configured Gyro default and
was confirmed by the running ACP adapter.

Actual dispatch: **5 GPT turns and 6 Grok turns**, including setup turns.
The GPT resumed-code setup timed out, so that task turn was not dispatched.
One condition is not a statistical sample sufficient to compare model quality
or speed. The watcher requests cancellation at 60 seconds; cleanup extends wall
time beyond that point. The slowest measured wall time was 64.56 seconds.

The runtime was a locally compiled debug executable, not an installed release.
Its SHA-256 was unchanged between launch and completion:
`844878cffec044b2992dfcfa32f73c3cd1c0c1a318d6a264078ed6b812a284b9`.
The source commit was `ebe4ae5f439d4fd0f6a8893f31c96e25be4e966c` plus the
then-current local changes. Other local development and a CLI build overlapped
part of the probe, so hardware load was not controlled. No user project or
normal Gyro store was used. Original disposable data remains at the path in
[run-metadata.json](run-metadata.json).

## Findings from the saved events

1. **Review is a real workflow state.** Both providers proposed README edits
   that remained pending. GPT's completed code reply explicitly said its edits
   were pending and verification was incomplete. This was an honest reply, not
   an applied code fix. The probe supplied no fixture reviewer, so it cannot
   treat those cases as evidence about autonomous editing capability alone.
2. **The benchmark layout blocked model terminals.** It placed repositories
   under the isolated app store's `workspaces` folder. Gyro correctly refused
   that private-data path: “only an individual managed workspace may be selected
   inside Gyro's private data directory.” The benchmark must place repositories
   outside the store; disabling confinement is unnecessary.
3. **File errors lost the cause.** Grok requested `src/clamp.test.mjs`, while
   the fixture's test file was at the root. The tool error only said “open
   workspace file …” because the broker discarded the underlying I/O error.
   The model needs the “not found” cause to distinguish a bad path from a
   permission or storage failure.
4. **Missing request counts looked like zero.** Native CLI generations do not
   enter Gyro's HTTP collector. Its zero was not evidence that no model calls
   occurred. Summaries now leave that count unmeasured and expose Grok's native
   `modelCalls` separately when the provider actually supplies it. Cancelled
   receipts in this probe do not supply a complete usage total or spend figure.

## Repairs verified without further model calls

- New benchmark runs use sibling `data` and `workspaces` directories. The native
  harness validates the store/root relationship. Resume and summary processing
  retain compatibility with the original layout, preserving this probe.
- A native regression test reproduces the private-store rejection for the old
  layout, then successfully runs confined `node --test` from the new layout.
- Tool errors now preserve their underlying causes, with the existing secret
  filtering and 4,000-character bound applied to the complete message.
- Summary tests cover both layouts, malformed layout rejection, pending edits,
  and native request-count provenance.

Validation: 8 desktop benchmark tests and 7 capability guard/error tests passed;
the summary regression script, Rust formatting, Prettier, and whitespace checks
passed. This probe's original workspaces and pending proposals were left intact.
The post-repair matrix has not been run. Fixture-only proposal review and native
Stop/callback latency still need attention before the next paid comparison.
