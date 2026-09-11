# Superseded alpha 47.4 baseline

These partial measurements belong to commit `a8ba292`, before the user requested
an update from main and a switch to `codex/alpha-47.6`. They are not results for
the updated branch and are not combined with the primary dataset.

The baseline retained 66 of 90 planned slots when interrupted: 29 completed
provider calls, 7 failed calls, and 30 Claude authentication failures classified
as unavailable. Fifty-one additional local rate-guard rejections from an initial
setup mistake were excluded and rerun before this checkpoint. An earlier
approval-configuration pilot is also excluded.

The first Grok trials were sequential; later providers ran concurrently. Early
Codex tool spans were reconstructed from the capability ledger because their
protocol hooks were incomplete. This is diagnostic history, not a controlled
before/after comparison with alpha 47.5.

This archive retains its original checker results. The primary updated-main report
includes a documented correction for punctuation in the mascot append prompt.
