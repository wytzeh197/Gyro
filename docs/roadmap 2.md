# Roadmap to v1.0

This is an outcome-based direction, not a release promise. Gyro is a public
macOS Alpha; check [GitHub Releases](https://github.com/wytzeh197/Gyro/releases)
for the current published build and its exact limitations. The
[vision](vision.md) is the source for product principles: one local workspace
for chat, CLI, and IDE, with local-first trust, clear agent state, and approval
before mutation.

## Product outcome

A developer installs Gyro without fighting Gatekeeper, opens a repository,
connects an agent they already use, completes and reviews a real change, then
continues the same work from chat, CLI, or the workspace without losing context
or control. Gyro should make that loop feel like one dependable product—not
three surfaces stitched together.

## Current focus: earn a confident public launch

### 1. Trusted macOS distribution — launch blocker

Replace the current ad-hoc-only app distribution with Developer ID-signed and
Apple-notarized artifacts. Keep the current warning and install guidance until
the new artifacts pass the full release gate.

- Confirm the Apple Developer account holder, enrollment, Team ID, and
  Developer ID Application certificate; use Developer ID, not Mac App Store
  distribution signing, for direct downloads. See Apple's [Developer ID
  certificate guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates).
- Design a least-exposure signing and notarization path for local builds and
  release CI. Store credentials only in the macOS keychain or protected CI
  secrets; never commit or print certificate material, API keys, or passwords.
- Audit every nested executable, framework, helper, entitlement, hardened
  runtime requirement, and Tauri setting before signing. In particular, review
  the current `macOSPrivateApi` setting for compatibility and necessity.
- Sign with a secure timestamp, submit the app/distribution to Apple's notary
  service, inspect the notary log, staple the ticket, and verify the final DMG
  and updater artifacts. Follow Apple's [notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
- Test downloaded artifacts on clean Apple Silicon and Intel Macs, including
  first launch offline, Gatekeeper assessment, install/update, app/CLI session
  handoff, and rollback. Publish only after checks pass; then update the site,
  README, release notes, and install guide together.

**Done means:** both architecture downloads launch from quarantine without
"Open Anyway"; their signatures, notarization tickets, checksums, and updater
signatures verify; the clean-machine path succeeds; and all public install
copy matches the actual release. See [macOS installation](install-macos.md),
[release process](release.md), and [clean-machine path](clean-machine-path.md).

### 2. Prove the unified coding loop — launch blocker

- Complete and repeat the clean-machine first-run path for supported Codex and
  Claude Code setups: provider readiness, first response, approved edit, and
  restart/resume.
- Demonstrate continuity between app and CLI using the same session, with
  truthful branch, run, approval, and changed-file state.
- Verify the common terminal, file, diff, browser, and review actions that the
  launch story will show. Be explicit about provider-specific gaps; do not imply
  unsupported adapters are approval-safe.
- Exercise recovery, cancellation, offline behavior, and update/rollback; fix
  launch-blocking issues and maintain a short known-limitations list.

**Done means:** an unfamiliar developer can complete one useful, approved
change on a clean machine, understand what Gyro did, and reopen the same work
without a maintainer walking them through it.

### 3. Explain Gyro clearly — launch asset

Make the launch film demonstrate one promise with real product evidence:
**the coding task stays together as you move between the agents, terminal, and
workspace you already use.** The film should be ambitious in craft and modest
in claims. Build the main cut and social variants from verified captures; see
the production brief in [launch-video-plan.md](launch-video-plan.md).

**Done means:** the first seconds establish the problem, the product appears
early, the core workflow is legible without sound, and every visible claim and
UI state is reproducible in the released build.

## Then deepen the product

1. **Session continuity and recovery.** Make task context, process status,
   approvals, changed files, failures, and next actions durable and easy to
   resume across app/CLI and restarts.
2. **A coherent workbench.** Keep files, diffs, terminal, browser, preview, and
   review attached to the active task; support clear user takeover and accurate
   capability labels.
3. **Trust that is inspectable.** Preserve local-first data, provider-owned
   authentication, keychain storage, approval boundaries, and honest run
   status. Make permission and recovery behavior understandable rather than
   merely configurable.
4. **Quality at the seams.** Prioritize clean install, provider setup, empty and
   error states, keyboard flow, accessibility, performance, and app/CLI
   compatibility over feature count.
5. **Open-source leverage.** Make focused contributor issues easy to reproduce,
   verify, and review; keep architecture checks and regression coverage aligned
   with real user outcomes.

## Explicitly not the next milestone

Do not make v1 depend on automatic multi-agent orchestration, general computer
control, hosted collaboration, multiple operating systems, or full standalone
IDE parity. Preserve the safeguards around Council while it remains in the
product; do not expand it just to make the launch story sound bigger. The open
local core remains useful without a Gyro-hosted service.

## How to use this roadmap

Turn priorities into small, verifiable milestones. Keep public claims aligned
with shipped behavior and published artifacts. A source-level check, local
build, clean-machine acceptance, and published release are distinct evidence
levels; state which one a result actually reached. See
[CONTRIBUTING.md](../CONTRIBUTING.md) and [release verification](release.md).
