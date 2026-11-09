# Browser tool sequence verification — 2026-11-08

The reported activity contained two separate failures: explicit dimensions paired with `responsive` mode were rejected, then a screenshot arrived before the new document committed. That original chat subsequently recovered and captured images successfully. This change removes the need for those two retries.

Explicit viewport dimensions now select a fixed desktop viewport when the mode is omitted, `auto`, or `responsive`. Existing dimension limits still apply; responsive mode without dimensions still follows the panel. The model-facing schema and saved reference contract describe this behavior.

Screenshot capture waits for the current pending document to commit within the existing operation deadline. Cancellation, browser replacement, a newer navigation, and navigation failure end the wait. Other document actions retain their existing document guards.

## Evidence

- All 62 Rust browser tests passed, including delayed commit, superseding navigation, cancellation, browser replacement, viewport normalization, and existing ownership/capture checks. See `rust-browser-tests.log`.
- All 15 core capability tests passed, including the configured API transport/tool-support regression. Trusted provider kind is frozen from configuration at turn binding; model arguments cannot declare it. See `core-capability-tests.log`.
- Browser capability, viewport, navigation-history, and session-isolation JavaScript checks passed.
- The native macOS WebKit sequence passed in fresh and resumed chats through the real provider/tool broker: open hidden page → set `{mode:"responsive",width:1440,height:960}` → immediately request screenshot. Both screenshots were requested before the server sent the new document. The server delayed each document by four seconds. The provider received actual PNG image bytes with a 1440 × 960 IHDR, and visual inspection confirmed the fixture heading and button. See `native-sequence.json`, `scripted-transport.json`, `validation.json`, and `native-page.png`.
- This used a keyless scripted loopback provider and disposable store/workspaces. Its HTTP server rejected Authorization headers. No connected provider account was called. Resumed setup used ordinary workspace reads.

Reproduce from the repository root with `node scripts/run-local-provider-runtime.mjs --browser-only`. The runner builds a debug executable and creates its own temporary data directory. The recorded native run reused the fresh debug executable built earlier in this session because another Cargo job held the build lock; it did not install or launch the normal app bundle.

## Limits

This establishes the tested development-build browser sequence and tool/image transport. It does not measure GPT/Grok reasoning quality, provider latency, Retina behavior, older WebKit, or release acceptance. The broader README/code/no-tool runtime matrix remains unaccepted: its earlier run had a terminal-wait harness mistake and then timed out. Those results are not counted as browser passes.

The installed Gyro app was not updated. Production Tauri configuration and Cargo.lock retained their previously recorded hashes. No commit, install, release, or deployment was performed.
