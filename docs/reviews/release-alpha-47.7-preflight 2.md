# Alpha 47.7 local preflight — 12 September 2026

Status: local automated preflight passed; publication acceptance remains pending.
These results describe the working tree at preparation time, not a tagged artifact.

## Preparation

- Extracted provider usage state, refresh handling, and background polling from
  App.tsx into use-provider-usage.ts without changing the polling behavior.
- App.tsx is 20,340 lines, below the existing 20,358-line working-tree ceiling.
  This preparation did not raise the ceiling.
- Updated Node packages, Cargo workspace and lockfile, Tauri config, and the
  Homebrew Formula template to 0.1.0-alpha.47.7.
- Added versioned release notes, with rollback to alpha.47.6.
- Updated the workbench source assertions to follow the extracted hook.

## Commands verified

- pnpm check: passed.
- pnpm test: full reliability suite and package tests passed.
- pnpm smoke:workbench: passed, including UI tokens; repeated after formatting.
- cargo fmt --all -- --check: passed.
- cargo test --workspace: 611 passed, 4 ignored, 0 failed.
- pnpm build: passed; Vite reports its large-chunk advisory.
- cargo build -p gyro-cli: passed.
- pnpm release:cli:check: Apple Silicon packaging smoke passed.
- cargo run -p gyro-cli -- doctor --json: exited successfully and returned
  the gyro.cli.v1 schema. This is not a claim that every provider is configured.
- pnpm release:check: passed.
- pnpm site:check: passed.
- git diff --check: passed.

## Verification limits and publication handoff

The embedded browser loaded the capture page, but its native event ACL rejected
the capture harness's event-listener calls. This attempt does not establish
visual or native UI acceptance. The automated workbench checks passed; the
earlier design QA records remain separate evidence.

Follow docs/release.md before publication: review and commit the candidate,
pass release PR CI, merge to main, then tag the exact merged commit. Build and
verify both architecture artifacts, perform clean-user installation and signed
updater acceptance, and verify session preservation before publishing.

Native provider connections, OS folder-picker behavior, permissions, notifications,
and desktop integration still need the acceptance coverage listed in the settings
review. No tag, release, upload, deployment, or publication was performed.

## Command-wait release update

The candidate now includes model-owned command waiting, cancellation, resource
identity checks, completed-output retention, and bounded final-output draining.
Terminal capability execution was extracted into terminal_capability.rs to keep
the existing desktop architecture ceiling unchanged. The screenshot in
../screenshots/command-wait-preview.png uses example release data and the actual
chat activity component with details expanded; it is not a live build run.

Refreshed validation and artifact acceptance results are recorded in the release
pull request. The clean-user installation and signed-updater acceptance items
above remain separate from automated checks.
