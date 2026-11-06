# Support and bug-fix workflow

GitHub Issues are Gyro's public intake for support and reproducible bug reports.
Wytze owns communication with reporters and decides which issues are ready for
engineering work.

## Flow

1. A user opens a bug report with reproduction steps and redacted environment
   details. Filing an issue does not put it in Arda's work queue.
2. Wytze reviews the report, asks the reporter for any missing details, checks
   for duplicates, and replies publicly when appropriate.
3. When Wytze wants Arda to inspect a specific report, he applies the
   maintainer-only `arda-ready` label. This is the explicit authorization gate;
   no label means no autonomous issue work.
4. During its scheduled triage, Arda checks only open issues carrying
   `arda-ready`. Arda verifies the report against the current code, avoids
   duplicates and already-fixed reports, and proceeds only when the issue is a
   clearly reproduced Green-lane bug within the limits below and Arda's current
   operating instructions.
5. Arda makes the smallest safe fix on the already-selected current version
   branch, runs focused checks and the relevant typecheck, then commits and
   pushes only if checks pass. Arda does not create a branch, open a PR, merge,
   tag, release, or contact the reporter.
6. Arda reports the issue number, evidence, changed files, checks, commit, push
   result, and any risks in the existing Arda chat. Wytze reviews the result and
   remains responsible for the public reply and issue closure after the fix is
   included in a release.

## Stop and hand back

Arda must not implement unclear, unverified, duplicate, or already-fixed
reports, nor anything outside Green lane (including feature requests,
cross-surface changes, dependencies, permissions, auth, providers, billing,
schemas, security, telemetry, deletion, broad refactors, or more than three
production files). Arda reports the reason in the existing Arda chat and waits
for Wytze. Failed checks mean no commit or push. Public security reports must
follow [SECURITY.md](../SECURITY.md), not this workflow.

The `arda-ready` label is a human-controlled queue signal, not a promise that a
fix will be made or that the issue is resolved.
