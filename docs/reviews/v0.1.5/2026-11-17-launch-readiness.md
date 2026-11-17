# v0.1.5 launch readiness — 17 November 2026

Status: source preparation and available local verification complete. Native
OS mouse and distribution acceptance remain outstanding; this candidate is
not cleared by local verification alone for public launch. The user has now
authorized committing, pushing and publishing; artifact acceptance still needs
to be established by the release workflow and acceptance checks.

## Candidate

Base commit: `51b85762` (`Harden desktop recovery, workspace I/O, and remote access`).
The local verification below covered the release preparation on `v0.1.5`
before its commit. Publication follow-through was authorized afterward.

- Aligned the root, desktop, UI, Code Mode, Cargo workspace, all four locked
  Rust packages, Tauri config, release identity and Homebrew template to 0.1.5.
- Added versioned release notes, including the summary consumed by the updater,
  intended architecture-specific downloads, signing requirements, upgrade and
  rollback guidance, and experimental-feature limits.
- Enabled push CI for the `v0.1.5` branch.
- Applied rustfmt to the existing formatting failures.
- Corrected Code Mode worker memory accounting to enforce the existing
  256 MiB budget against the greater of resident size and macOS physical
  footprint, including compressed allocations. The threshold, sampling
  interval and existing regression assertion are unchanged.

The original checkout contains pre-existing untracked files with ` 2` suffixes.
They fail the guard registry and include an outdated TypeScript component.
They were preserved. Node/browser checks use an isolated tracked-file snapshot
with the candidate changes and new release notes overlaid. The changed files
were compared byte-for-byte with the working checkout before verification.
Rust integration-test discovery also picked up duplicate test filenames, so
the Rust suite uses that same isolated snapshot with the original target
directory as its compilation cache. CLI validation uses the working checkout.
The final debug app bundle and native smoke checks use the isolated candidate.
The final bundle reused the already verified, unchanged production frontend
through a temporary build-command override; signing settings were preserved.

The 25 changed/new candidate files (excluding this report) match byte-for-byte.
`/tmp/gyro-v015-source-manifest.txt` lists their hashes. Its SHA-256 is
`1c2f1e45cb1fe62c3f6b4c860747ec5979ffc072804dffa260c22975f8b49c4b`.

## Verification

All results below are from commands run in this session. Raw logs and browser
artifacts are local evidence, not public release artifacts.

| Check | Result | Local evidence |
| --- | --- | --- |
| Locked dependency installation and developer doctor | Passed | `/tmp/gyro-v015-candidate-install.log`, `/tmp/gyro-v015-clean-doctor.log` |
| Release config with `GITHUB_REF_TYPE=tag`, `GITHUB_REF_NAME=v0.1.5` | Passed | `/tmp/gyro-v015-release-check-final.log` |
| `pnpm check` | Passed | `/tmp/gyro-v015-clean-check.log` |
| Complete `pnpm test` | Passed | `/tmp/gyro-v015-clean-node-tests.log` |
| Production frontend build | Passed; existing large-chunk warning | `/tmp/gyro-v015-production-build.log` |
| `pnpm smoke:workbench` | Passed; 172 rendering states | `/tmp/gyro-v015-clean-workbench.log` |
| `pnpm test:launch-browser` | Passed; Environment, remote access, storage, Usage, drag, tour, Check | `/tmp/gyro-v015-clean-launch-browser.log` |
| Remote browser fixture | Passed; 33 checks, zero runtime errors | `/private/tmp/gyro-remote-browser/result.json` |
| Durable editor recovery browser | Passed; 2 MiB conflict draft restored, cleared without resurrection | `/tmp/gyro-v015-clean-recovery-browser.log` |
| Focused chat and terminal browser checks | Passed | `/tmp/gyro-v015-chat-browser.log`, `/tmp/gyro-v015-terminal-browser.log` |
| Rust unit/integration suites after memory fix | Passed; 2,399 passed, 25 ignored, zero failed | `/tmp/gyro-v015-rust-final-tests.log` |
| Rust documentation checks | Passed in serial rerun | `/tmp/gyro-v015-rust-doc-final.log` |
| Code Mode source guard after memory fix | Passed | `/tmp/gyro-v015-code-mode-guard-final.log` |
| Rustfmt and diff whitespace | Passed | `/tmp/gyro-v015-rustfmt-final.log`, `git diff --check` |
| CLI build, archive/checksum/Formula/manifest construction | Passed on Apple Silicon; cross-architecture construction uses fixtures | `/tmp/gyro-v015-cli-build.log`, `/tmp/gyro-v015-cli-package.log` |
| CLI doctor | Passed; `gyro.cli.v1` | `/tmp/gyro-v015-cli-doctor.log` |
| Isolated real macOS Keychain | Passed; eight fresh processes, synthetic values, cleanup | `/tmp/gyro-v015-keychain.log` |
| Final debug app bundle | Built; plist version 0.1.5, arm64 executable | `/tmp/gyro-v015-debug-bundle-final.log` |
| Native browser mouse | Foreground guard stopped both attempts; acceptance pending | `/tmp/gyro-v015-native-smoke-final.log` |
| Native browser fixture with OS mouse omitted | Passed limited scope; skipped OS input explicitly, production guard unchanged | `/tmp/gyro-v015-native-browser-limited.log` |
| Packaged native language server | Passed; definition, references and document symbols | `/tmp/gyro-v015-native-smoke-final.log` |
| Packaged native broker | Passed; seven scenarios, scripted provider, no model generation | `/tmp/gyro-v015-code-mode-native-final.log` |

The complete Node suite ran before the Rust-only memory accounting fix; the
affected Code Mode guard was rerun afterward. Final Rust runtime suites include
the fix. The first final Rust invocation passed every runtime test but its
desktop doctest build encountered incompatible shared artifacts while the
native build used the same target directory. Documentation verification passed in a serial rerun without an overlapping
native bundle build. The full native
smoke command exits nonzero because mouse acceptance is incomplete, even
though its packaged language-server checks passed. A separate limited browser
run omitted OS mouse scenarios explicitly; that result is not full native
mouse acceptance.

Visually inspected the narrow retry notice, terminal frame, delayed remote-file
reload editor and light remote workspace screenshots. This supports the fixture
results; it does not establish physical-host or installed-upgrade acceptance.

## Worker memory regression

The first isolated full Rust run reached 1,101 passing desktop tests, with one
failure and 13 ignored. `real_worker_memory_is_bounded` returned
`TimeoutExceeded` instead of `MemoryLimitExceeded`; the exact test failed again
on its own. The test retains and touches 320 MiB without unbounded growth.

A diagnostic probe of the same worker measured a retained physical footprint
of 352.2 MiB with only 56.3 MiB resident after 15 seconds. Resident-only polling
can miss the budget under compression. The corrected sampler uses libc's SDK
`rusage_info_v0` and `proc_pid_rusage`, taking the maximum of resident size and
physical footprint. Apple accounts for compressed allocations in its
[physical-footprint ledger](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c).

Before logs: `/tmp/gyro-v015-rust-clean-tests.log`,
`/tmp/gyro-v015-memory-recheck.log`,
`/tmp/gyro-v015-memory-footprint-probe.log`.
The unchanged regression passes in the final runtime suite. No test limit was
raised or assertion removed.

## Required before publication

- Complete the native OS mouse smoke on a desktop that satisfies the
  foreground-window precondition. The guard was preserved, and the full
  native smoke command is not marked as passing. An idle-desktop retry was
  offered; no response was received during the remaining checks.

1. Review and commit the candidate, obtain passing CI and merge into `main`.
   Tag the exact merged commit as `v0.1.5` only after approval. The release
   workflow requires main ancestry and matching immutable release identity.
2. Build both architecture artifacts through the release workflow using its
   configured signing infrastructure. Verify Developer ID, notarization,
   stapled tickets, architecture, checksums and updater signatures. Never put
   signing credentials in this report or supply them in chat.
3. Complete clean-user, quarantined-download installation, including offline
   Gatekeeper acceptance. Execute the Intel app and CLI on Intel hardware or
   its native runner.
4. Upgrade an older approved installation using the signed updater. Confirm
   retained sessions, drafts, provider access, memory/workflows and the v0.1.5
   What's new notice. Verify invalid updater signatures are rejected. Confirm
   CLI/app session handoff and supported backup/rollback behavior.
5. Physical two-Mac and WAN/reconnect/sleep-wake acceptance with a live
   provider remains pending: the user confirmed no second Mac is available for
   this session. Keep remote access experimental until this evidence exists. The
   broader live cross-provider, visual-fix and workflow-reuse limits remain
   documented in the release notes.
6. Replace the release notes' pending-artifact disclosure with the actual
   acceptance status only after those checks pass. Publication and changes to
   the public latest release, updater channel, website and Homebrew tap remain
   separate actions.

The initial preparation pass performed no merge, tag, push, draft release,
publication, public channel change or installation over the user's existing
app. On 17 November 2026 the user authorized committing and pushing the launch
preparation, followed by publication. This authorization does not turn any
pending acceptance check into a passing result.
