# Rust tester preflight — 2026-10-14

Candidate: `/Users/wytze/Gyro` HEAD ca28b906 plus initial dirty worktree and the focused fixes/tests recorded below. Rust toolchain 1.96.1. Installed Gyro PID 76440 remained running at its original `/Users/wytze/Applications/Gyro.app/Contents/MacOS/gyro-desktop` path.

## Verified outcome

- `pnpm --filter @gyro-dev/codemode build`: passed, rebuilt required confined worker.
- `CARGO_INCREMENTAL=0 cargo test --workspace --locked --no-fail-fast -- --test-threads=4`: 1,345 passed, 0 failed, 7 initially ignored. Final log: `cargo-test-workspace-postfix.log`.
- Breakdown: CLI units 40; CLI integration 25; actual symlink-installed CLI doctor regression 1; core 590; efficiency checkpoint 3; event compatibility 1; desktop 685. Empty main/doc test targets also passed.
- Both initially ignored live Ollama tests passed using the already-installed `qwen3:0.6b`, with no downloads. Context probe retained 18,039 prompt tokens in requested 20,480 context (model maximum 40,960), produced 85 output tokens and no tools. Cancellation after visible output returned in 0.203 ms. Evidence: `cargo-test-ollama-live.log`, sibling `../ollama/ollama-live-context.json` and `ollama-live-cancel.json`.
- All five desktop opt-in tests were then executed directly from freshly built `target/debug/deps/gyro_desktop_lib-5fac4023e7aeebf3` to avoid rebuilding while the parent built the native app. Live model catalog equality, Codex account usage, and installed provider CLI argument acceptance passed. Claude account usage failed because the endpoint rejected the stored sign-in (HTTP 401/403); Kimi account usage failed because the upstream payload yielded no recognized plan usage window. These two results remain live limitations; Kimi schema/account cause was not diagnosed. Log: `desktop-opt-in-live.log`. Sensitive usage numbers were kept local.
- `CARGO_INCREMENTAL=0 cargo build -p gyro-cli --locked`: passed. Explicit build log: `cargo-build-cli.log`.
- After independent review, the Kimi/xAI ACP fixture was tightened to explicitly accept only known initialization/authentication/session/model/config/mode/prompt methods; unknown requests fail. Its focused real-binary test passed in 1.54s: `cli-acp-fixture-final.log`. No repeated workspace breadth after this fixture-only tightening.

## Failures investigated and repaired

Initial workspace suite failed two CLI expectations that still configured Gemini. The intentional dirty product migration removes Gemini provider/profile state, so the binary correctly blocked the removed test profile rather than running it. `exit_codes.rs` now tests currently supported Kimi and xAI success through the shared ACP adapter, retains cancellation/refusal coverage for supported CLI ACP providers, and adds real-binary verification that legacy Gemini config disappears without copying authentication/defaults/inventory to Antigravity, and cannot start a removed executable or create a session.

An initial 590-test core run had one scheduling-sensitive `kimi_acp::tests::oversized_frame_without_newline_fails_before_the_peer_closes` elapsed-under-2s assertion failure at `kimi_acp.rs:2019`. The focused test passed in 0.19s; complete controlled-concurrency core reruns passed. Original red retained in `cargo-test-core-desktop.log`.

The distribution agent found and fixed a real macOS executable-path identity defect in the private process guard/keychain reader: `/var` aliases and symlink launches disagreed with kernel physical paths. It canonicalized both sides while retaining PID/socket peer checks, and added `macos_install_paths.rs` to exercise the actual symlink-installed CLI with real Git. The regression passed in the complete workspace suite; parent/distribution own the full fix and packaging evidence.

## Advisory failures retained

`cargo fmt --all -- --check` failed across 38 Rust files. Read-only comparison of every flagged HEAD file through rustfmt confirmed all 38 were already unformatted at HEAD (`fmt-baseline.json`). Existing dirty configuration additions also have local formatting drift. No broad reformat was applied.

`cargo clippy --workspace --all-targets --locked -- -D warnings` failed on existing lint debt, including declared Rust 1.78 MSRV versus existing APIs stable in 1.82, large ureq error values/style lints, and test-only unhandled IO byte counts at `web_fetch.rs:313`. Strict log: `clippy-strict.log`. CI does not gate on fmt or clippy. To inspect all crates/targets fully, `cargo clippy --workspace --all-targets --locked -- -W clippy::all` completed successfully with warnings (`clippy-advisory.log`): core library 21; CLI 4; desktop library 32, plus test duplicates/additional diagnostics. This does not make strict clippy green.

## Files changed by this agent

Only `crates/gyro-cli/tests/exit_codes.rs`: migrate stale supported-provider expectations, add legacy retirement/block-before-spawn integration assertion, and use exact returned ACP request ids with explicitly bounded accepted methods. Product source fixes were owned by the distribution agent. `git diff --check` passed.

## Resource handling

Initial free disk 3.6 GiB, workspace target 14G (debug 12G, incremental 4.1G, deps 6.1G), nested src-tauri target 2.5G. The parent centrally removed only regenerable incremental and unused nested target caches; this agent deleted no artifacts. All Rust compilation here used `CARGO_INCREMENTAL=0`, and cargo work was coordinated serially. Temporary homes/workspaces isolate binary tests from the installed user app.

Memory was used for safe generated-cache and runtime-identity verification practices, then current state was verified live. Sources: MEMORY.md:60-61 (cleanup), skills/gyro-local-dev-verification/SKILL.md:35-40 (fresh bundle identity), rollout 01a1347b-0750-74e1-af11-9d6381187828. User/parent requirement to retain installed PID superseded the older skill's close-installed-app instruction.
