# Tester distribution audit

Source/config audit of /Users/wytze/Gyro, HEAD ca28b906 plus existing local dirty changes, 2026-10-14. A confirmed executable-alias bug was fixed locally under the parent's explicit readiness authorization. No Git refs, installed artifacts, credentials, or release publication were changed by this agent.

## Checks executed

- `CI=true pnpm release:check`: passed; `release-check.log`.
- `CI=true pnpm doctor`: passed; `doctor.log`.
- `CI=true pnpm release:cli:check`: initially failed using both the October 13 stale binary and the October 14 08:50:07 fresh binary. Isolated installed CLI `doctor --json` exited 3: required Git check failed with message `start git`. Shell `/usr/bin/git --version` succeeds (2.50.1). Initial evidence: `cli-packaging.log` and `cli-packaging-fresh.log`.
- After the fix and October 14 08:58 fresh CLI build, `CI=true pnpm release:cli:check` passed on aarch64-apple-darwin. This exercises deterministic archives, extracted installed CLI version/completions/doctor, tampered archive checksum rejection, final checksums and generated Formula. Final evidence: `cli-packaging-fixed.log`. This is native Apple Silicon evidence, not Intel execution proof.
- After the fix, all alias/physical/symlink CLI doctor paths and both direct Git forms pass with identical temporary HOME/environment. Final evidence: `doctor-path-fixed.json`.
- New regression file `rustfmt --check` and `git diff --check` pass. Rust agent separately owns full workspace tests and their result logs.

## Confirmed executable-alias blocker and local fix

Identical fresh CLI bytes with identical temporary HOME/environment produce deterministic different results: launching `/var/.../gyro` fails doctor, launching its physical `/private/var/.../gyro` passes, and launching an executable symlink fails. Both `git --version` and `/usr/bin/git --version` pass under the same environment. This is a functional installation-path bug rather than Git absence, stale code, or resource exhaustion. Evidence: `doctor-copy-diagnostic.json`, `doctor-path-diagnostic.json`.

The process watchdog's trusted parent guard at crates/gyro-core/src/process_guard/macos.rs:263-275 compared `proc_pidpath(parent)` directly with `current_exe()` path bytes. The former is physical, while the latter may retain `/var` or a Homebrew executable symlink. That mismatch rejects the watchdog before it can launch Git or provider commands. The same defect existed in the Keychain reader's parent guard at crates/gyro-core/src/keychain/macos_read.rs:205-217.

The local fix canonicalizes both executable paths before equality in both guards. Kernel socket-peer/parent PID authentication and child lifetime/starttime checks remain unchanged, and canonicalization failures reject the parent. A new actual-binary macOS symlink-install regression is in crates/gyro-cli/tests/macos_install_paths.rs. Rust agent owns the fresh workspace build and full regression run. Post-fix packaging and alias/physical/symlink verification pass as listed above.

## Distribution contract

- Root/desktop/UI/Cargo/Tauri/Cargo.lock versions agree at 0.1.0-alpha.49.7; release:check verifies this (scripts/check-release-config.mjs:107-187).
- Minimum macOS is 14.0; checked-in signature is ad-hoc `-` (apps/desktop/src-tauri/tauri.conf.json:55-57). This local build is not evidence of Developer ID trust or notarization.
- Updater uses one shared public GitHub latest channel (tauri.conf.json:60-65). Draft/prerelease assets are excluded from GitHub latest per docs/release.md:22-32. Private candidate builds have no separate channel.
- App/CLI architecture contract is Apple Silicon and Intel. Both native architectures are built in release workflow, but this Apple Silicon Mac cannot establish Intel execution.
- The current versioned Alpha49.7 release notes describe earlier appearance/provider reliability changes (docs/releases/v0.1.0-alpha.49.7.md:3-5,22-45). They do not describe the local Google retirement. The private tester candidate needs artifact hashes and a source snapshot because the version alone does not distinguish it.

## Google retirement assessment

- Gemini provider/profile deletion is intended product behavior, explicitly documented in the dirty docs/google-backends.md:5-10 and implemented by crates/gyro-core/src/config.rs:557-566. Credentials are not transferred to Antigravity.
- CLI integration tests at crates/gyro-cli/tests/exit_codes.rs:489-557 and 560 onward still expect enabled Gemini test profiles to execute. Config normalization deletes those fixtures; do not restore retired Gemini product behavior simply to satisfy the stale tests. Replace stale success expectations and preserve negative migration coverage.
- README.md:81-83 still advertises Gemini CLI and needs to match the retirement.
- Antigravity has no CLI ACP runtime arm (crates/gyro-cli/src/main.rs:1772-1826) or built-in command profile; executing a manually-added profile reaches missing-runtime failure at main.rs:3253. This gap predates the dirty retirement. Antigravity is already experimental and API-key only (docs/google-backends.md:14-27); README.md:127-128 limits API-key providers to the app. Explicitly describe Antigravity as app-only experimental for this tester build rather than claiming CLI parity.
- Antigravity runtime is separately installed, not bundled (docs/google-backends.md:44-53), and authenticated chat/tool/approval/resume acceptance is not established (docs/google-backends.md:14-15,71-74).

## Acceptance still requiring native/distributed evidence

docs/release.md:309-327 requires verified/checksummed DMGs, browser-downloaded quarantine and clean-user Open Anyway behavior, Intel native execution, updater upgrade/relaunch/session preservation, rejection of invalid updater manifests/signatures, and CLI/app session handoff. A successful release:check or local bundle launch cannot establish these.

The Obsidian project note /Users/wytze/Obsidian/JARVIS/20-Projects/gyro.md says repository/source and live release evidence are authoritative and a local branch/commit is not proof of shipment. Its old checkout snapshot was not treated as current.
