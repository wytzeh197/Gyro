# Roadmap to v1.0

Plan date: 2026-08-28. Current version: v0.1.0-alpha.40.

This document carries Gyro from the current public alpha to v1.0. It is the
sequencing document; it does not restate strategy.

- [vision.md](./vision.md) defines the pillars, the moat, and the open-core
  boundary. It remains authoritative and unchanged by this plan.
- [product-entry-and-workbench-plan.md](./product-entry-and-workbench-plan.md)
  defined Phases A-E for entry and distribution. Phases B, D, and E have
  shipped; Phase A is this plan's M1 and Phase C is folded into M2. Treat that
  document as the requirements source for those phases, not as a live tracker.
- [cli-missions.md](./cli-missions.md) defines mission phases 0-4. Phase 1
  lands here as M4; phases 2-4 are explicitly post-v1.0.
- The local product-readiness audit is a point-in-time audit dated 2026-07-13
  and is now stale. M2 re-runs it; it is intentionally not part of the public
  repository.
- [launch.md](./launch.md) defines the public launch order. Its steps 3-6 are
  gated on M1.

## Where Gyro Actually Is

Releases alpha.34 through alpha.40 were reliability and honesty work on the
single-agent loop: run-rail truthfulness, crash recovery, background tasks,
macOS permission prompts, real task discovery, and measured provider usage.
That was the correct priority and it matched the vision's instruction that
alpha priority remains a dependable single-agent loop. It also means no
roadmap document has driven the work for six weeks.

What is shipped and honest today: five provider CLIs through local logins,
local Ollama models through a loopback-only API, shared sessions across app and
CLI, PTY terminals, Monaco editing with guarded saves, search, Git status,
real task discovery and custom commands, diffs, browser preview, approval
policies, worktrees, persisted automations, a signed updater, and a download
site with architecture detection.

What is not: an installable-without-ceremony build, a proven clean-machine
first run, and any mission surface.

## What v1.0 Means

v1.0 is reached when a developer who has never seen Gyro can install it
without a terminal command or a Gatekeeper override, open a repository, run an
agent through a real change, approve it, and resume that session tomorrow from
either the app or the CLI — across every provider Gyro claims to support.

v1.0 is not an IDE replacement, not multi-agent orchestration, and not a
hosted product. Those judgments follow directly from vision.md and are not
reopened here.

The v1.0 claim is the positioning line in launch.md: _Gyro puts chat, CLI, and
IDE in one local workspace, across the coding agents you already use._ That
line may be used publicly only when M2 passes.

## Milestones

| ID  | Name                | Gate                                                                                |
| --- | ------------------- | ----------------------------------------------------------------------------------- |
| M0  | Ship alpha.39       | Tag exists; release published                                                       |
| M1  | Signed distribution | Notarized DMG installs with no Gatekeeper override on clean Apple Silicon and Intel |
| M2  | Proven loop         | Clean-machine acceptance passes for all shipped providers; audit refreshed          |
| M3  | Structural debt     | No single source file over 4,000 lines; growth gated in CI                          |
| M4  | Mission shell       | Goal chat owns manual workers under one parent, with honest per-worker state        |
| M5  | v1.0 hardening      | Every visible control is functional, truthfully unavailable, or omitted             |

### M0 — Shipped: alpha.39

Alpha 39 was merged, tagged as `v0.1.0-alpha.39`, and published with matching
release notes and version surfaces.

Alpha 40 continues the local-first provider and workspace work without folding
in signing changes. M1 still changes the release verifier's assertions, so a
failed signing attempt cannot strand this finished Alpha release.

### M1 — Signed Distribution

This is the current milestone. It is mostly a purchase and a configuration
change, not a large engineering effort — but every downstream launch step
depends on it, and it has been the blocker since the July audit.

The gap is exact. `apps/desktop/src-tauri/tauri.conf.json` sets
`macOS.signingIdentity` to `"-"`, which is ad-hoc. There is no entitlements
file. `.github/workflows/release.yml` passes updater-signing secrets but no
Apple secrets. And `scripts/verify-macos-release.mjs` actively _asserts_
ad-hoc: it requires the markers `Signature=adhoc` and `TeamIdentifier=not set`,
and it fails the build if the signature contains `Authority=` or
`Developer ID`. Those assertions must be inverted, not merely relaxed — the
verifier should fail closed on an unsigned bundle exactly as strictly as it now
fails on a signed one.

Work:

1. Enroll in the Apple Developer Program and issue a Developer ID Application
   certificate. This is a prerequisite with a real lead time; start it first.
2. Add a hardened-runtime entitlements file. Gyro embeds a web view and spawns
   provider CLIs as child processes, so the JIT and unsigned-executable-memory
   entitlements are required. Grant nothing beyond what the app demonstrably
   needs, and record the justification for each entitlement in the file.
3. Set `signingIdentity` to the Developer ID identity and wire the standard
   Tauri Apple environment variables as repository secrets. Tauri v2 notarizes
   and staples when the notarization credentials are present.
4. Invert the signature assertions in `verify-macos-release.mjs`, and add
   `spctl --assess --type exec` and `xcrun stapler validate` to the same
   verifier so Gatekeeper acceptance and the stapled ticket are proven in CI
   rather than assumed.
5. Extend `check-release-config.mjs` so `GYRO_REQUIRE_RELEASE_SECRETS`
   demands the Apple secrets alongside the updater secrets. A tagged release
   without signing credentials must fail before it builds.
6. Publish the Homebrew Cask for the app from the same immutable artifacts.
   Only the CLI tap exists today.
7. Remove the unsigned disclosure from README.md, docs/install-macos.md,
   the release-notes template, and the download site — but only after a clean
   machine has confirmed the flow, never in the same change that adds signing.

Gate: a tagged release installs and launches from the DMG on clean Apple
Silicon and Intel machines with no **Open Anyway** step, and `spctl`,
`codesign --verify --deep --strict`, `stapler validate`, and SHA256
verification all pass.

Risk: hardened runtime can break child-process spawning or the web view in
ways that only appear in the notarized build, not in local development. Budget
a full release cycle for M1 alone and test the notarized artifact, not a local
build.

### M2 — Proven Loop

The July audit's highest-risk gaps 1, 2, and 3 all reduce to the same missing
evidence: nobody has run Gyro end to end on a machine that was not the
development machine. This milestone produces that evidence and refreshes the
audit against it.

The procedure is already written. [clean-machine-path.md](./clean-machine-path.md)
specifies the manual acceptance steps for Codex and Claude, backed by
`check-clean-machine-path.mjs` and the shared
`packages/ui/src/clean-machine-path.ts`. M2 does not invent it — M2 extends it
and finally runs it for real.

Work:

1. Extend the clean-machine path to cover what it currently declares out of
   scope: the remaining three shipped providers, macOS permission grants on
   first launch, CLI-to-app handoff and app-to-CLI resume, one automation run
   with pause and cancel, and recovery after a forced quit mid-run.
2. Run it on a clean macOS account for both architectures. Every provider that
   README.md lists under "What Works Today" must pass or be demoted in that
   list. The audit's note that a Claude Max probe returned HTTP 401 before any
   tool callback is still open and must be closed with a real authenticated
   run.
3. Close the physical sleep/wake and notification-delivery proof for
   automations. The audit records these as simulated only.
4. Resolve the LSP and DAP labels. They have been "experimental" since July
   without process lifecycle, cancellation, or crash recovery. Either implement
   that lifecycle or remove the surfaces from the default path. Do not carry an
   experimental label into v1.0.
5. Rewrite `product-readiness-audit.md` against the result and date it.

Gate: the acceptance script passes unmodified on a clean machine for both
architectures, and the refreshed audit reports no highest-risk gap that blocks
a first-time user.

### M3 — Structural Debt

`apps/desktop/src/App.tsx` is 18,576 lines. `packages/ui/src/surfaces.tsx` is
23,162. `apps/desktop/src-tauri/src/lib.rs` is 27,895. Roughly 70,000 lines sit
in three files, and no roadmap document has ever mentioned it.

This is not a rewrite and it is not a milestone that ships anything a user
sees. It exists because M4 adds a new surface, and adding a mission shell to a
23,000-line file is where a two-week feature becomes a two-month one. Doing it
after M2 means the extraction is validated by an acceptance script that already
passes.

Work:

1. Extract along surface boundaries, one surface per change, each landing
   green. Chat, Workspace, Settings, and the run rail are the natural seams;
   `packages/ui/src/` already demonstrates the target shape with its per-concern
   modules.
2. Split `lib.rs` by Tauri command domain, matching the existing `gyro-core`
   module layout.
3. Add a file-size ceiling as a new `scripts/check-file-size.mjs` wired into
   `pnpm test:reliability`, alongside the other invariant checks. Set it at
   4,000 lines with an explicit, dated allowlist for whatever has not been
   extracted yet, and shrink the allowlist as work lands.

Gate: no source file over 4,000 lines outside the allowlist, the allowlist is
empty or dated, and the M2 acceptance script still passes unmodified.

### M4 — Mission Shell

This is cli-missions.md Phase 1 and nothing beyond it: a goal chat that owns
manually created workers under one parent, with explicit per-worker state.
There is no `mission` symbol anywhere in the codebase today, so this is the
first genuinely new product surface since alpha.36.

Phase 1 only. No plan card, no automatic spawn, no cross-worker integration.
Per cli-missions.md's own sequencing instruction, automation comes only after
the shell is calm and honest.

Work:

1. Mission as a persisted parent entity in `gyro-core`, owning child sessions.
2. Goal chat as the single control plane; workers are not peer chats.
3. Manual worker creation bound to a subgoal, defaulting to one runtime, with a
   worktree per parallel worker.
4. Honest per-worker state: idle, running, waiting, blocked, done, failed.
5. Approval before mutation stays visible per worker. Parallel work must not
   become silent mutation — this is the one place where the vision's approval
   pillar is easiest to lose.
6. Soft cap of four workers, hard cap of eight.
7. The existing single-CLI launch path stays as the power path.

Gate: a mission with three workers on separate worktrees runs to completion
with every mutation individually approved, and every worker's state is
readable at a glance without opening it.

### M5 — v1.0 Hardening

Work:

1. Audit every visible control against the vision's "no fake activity"
   principle. The July audit found placeholder controls routed only to a toast;
   confirm none remain. This is a measure listed in
   product-entry-and-workbench-plan.md's success measures and has never been
   reported on.
2. Close the known limits carried in the alpha.39 notes: budgets are enforced
   and displayed but not editable in Settings, and the spend origin breakdown
   is unrendered. Ship both or remove the surfaces.
3. Establish golden CLI output compatibility from a published baseline. The
   July audit flags this as the one unmet part of the machine-output
   requirement.
4. Version and freeze the `gyro.cli.v1` contract and the session store schema.
   v1.0 is the first release where breaking either costs users real data.
5. Write the v1.0 migration and rollback path from the alpha data directory.

Gate: the positioning line in launch.md is defensible without qualification.

## What Gets Cut

These are decisions, not deferrals to revisit each milestone.

**Council stays frozen.** It is roughly 1,500 lines of Rust plus UI, and
`check-council-freeze.mjs` already enforces its frozen state. Parallel answers
are a different product from parallel execution, and shipping both would make
missions harder to explain. It does not ship in v1.0. Keep the freeze check.

**Mission phases 2-4 are post-v1.0.** Plan cards, automatic spawn, and
cross-worker integration are the interesting part and the reason to build M4
first — but shipping automatic multi-agent spawn on a product whose
clean-machine loop was proven only one milestone earlier inverts the risk
order.

**Windows and Linux are post-v1.0.** The entry plan already forbids showing
unsupported operating systems to appear broader. v1.0 is macOS 14+.

**The paid layer is post-v1.0.** Cross-device session continuity is first on
the vision's ladder and is the right first paid feature, but it requires hosted
infrastructure and a privacy posture that does not exist. Nothing in M1-M5
should foreclose it: keep the session store's identity and event model clean
enough that a sync layer can be added above it without a schema break. That is
the only accommodation v1.0 makes for it.

**Full IDE parity is out**, permanently at this scope. vision.md already says
the integrated IDE surface is part of the agent workflow, not a replacement for
a mature editor. Do not let M5's "every control is functional" audit turn into
an argument for building missing editor features; the honest resolution of an
incomplete editor surface is to scope it, not to complete it.

## Sequencing Rationale

M1 before everything because it is the only blocker that cannot be worked
around, has an external lead time, and gates four of the six launch steps.

M2 before M3 because the acceptance script is what makes a large refactor safe
to attempt.

M3 before M4 because M4 adds surface area and the cost of adding it to the
current files is the argument for M3.

M4 last among the feature milestones because it is the differentiator and
should be built on a proven, installable, maintainable base — not used to
carry one.

## Open Questions

- Universal binary versus two architecture DMGs. The entry plan permits a
  universal binary if proven small and reliable; a Developer ID makes the
  comparison worth re-running during M1, since it halves the notarization
  matrix.
- Whether Gemini stays in the supported list through M2. It has no plan-window
  API and reports local ledger spend only; if it also fails clean-machine
  acceptance, demoting it is more honest than carrying it.
- Whether M3's ceiling is 4,000 lines or lower. Pick the number that makes the
  allowlist honest rather than the number that makes it short.
