# Settings and Remote Control fixes — 17 November 2026

Implements the 15 findings from the Settings/Remote access audit. No commit, push, install, or deployment. Existing concurrent changes in this checkout were preserved; this report describes only this task's changes.

## Security

| Finding | Implemented change | Main source | Verification |
|---|---|---|---|
| S1: plaintext provider keys and device identity | macOS writes use Keychain. Startup migrates legacy entries under a cross-process lock, verifies secure writes before removing plaintext, and preserves the existing device identity. Denied identity reads never generate a replacement. | `crates/gyro-core/src/keychain.rs`; `keychain/local_secrets.rs`; native `app/config.rs` | Migration failure/preservation tests passed with synthetic credentials. Actual login-Keychain migration was not run against the user's credentials. Startup migration failures retain data and show a notification. |
| S2: invalid name prevents OFF | Admission is stopped immediately; OFF is persisted before slow teardown and ignores invalid name drafts; valid renames while off still work. Clicking OFF skips the name's blur-save. | native `features/remote_access/commands.rs`; `crates/gyro-remote/src/store.rs`; `remote-access/settings.tsx` | Store regression passed for empty-name shutdown and renaming while off. |
| S3: removed key reappears | Delete the Keychain entry and legacy file entry under the migration lock, then invalidate the read cache. Failed deletions surface as errors. | `crates/gyro-core/src/keychain.rs` | Migration/deletion transaction regression passed; native Keychain API path compiled. |
| S4: cleanup restarts networking while disabled | Runtime creation requires opt-in before reading identity/binding. Release/unwatch use an existing runtime only. Every OFF tears down listeners, connections, terminals, watches, and event subscriptions, including repeated OFF or persistence failure. | native `features/remote_access/{commands,mod}.rs` | Native verification below; transport shutdown tests passed. Outgoing SSH remains a separate, explicitly initiated connection. |
| S5: global browser-capture access | Native session captures record ownership. Remote image reads require that owner to match the authorized session. | native `browser/preview.rs`; `features/remote_access/media.rs` | Cross-session ownership regression passed. Older captures without ownership records fail closed remotely; new captures work through the normal session capture path. |
| S6: missing activity history | Bounded metadata ledger: device, action, chat, time, success/failure, count. Settings shows the latest 50 records; storage retains 1,000. Repeated actions within a minute are coalesced. No prompt, path, file body, terminal bytes, or credentials enter this ledger. | `crates/gyro-remote/src/{protocol,store}.rs`; native `features/remote_access/mod.rs`; `remote-access/settings.tsx` | Bound/coalescing tests passed; browser rendered the Settings empty state. |

## Bugs

| Finding | Implemented change | Main source | Verification |
|---|---|---|---|
| B1: reversed terminal inputs | Queue the entire claim/input transaction before asynchronous work. Adjacent bytes are coalesced in order. Failed/uncertain batches reject queued callers without replay. | `remote-access/{client,use-workspace}.ts` | Controlled RTT tests passed for order, batching, lease reuse, and connection failure. |
| B2: 17 projects exhaust transport | Share an eight-request budget across client instances for each host. A failed project preserves successful and previously known project results instead of marking the host offline. | `remote-access/{client,catalog}.ts` | 50 requests from two clients peaked at eight concurrent requests; 17-project catalog remained online with one failed project. |
| B3: truncated live catch-up and broken resync | Compact adjacent deltas by text-block identity, keep the last sequence cursor, replace the current live checkpoint on reconnect, and request catch-up on every resync. Exceeding the bounded checkpoint produces an explicit warning. | `crates/gyro-remote/src/live_events.rs`; native `dispatch.rs`; `remote-access/{client,use-workspace}.ts` | 10,000 uniquely identified delta frames preserved their prefix and final cursor. Existing ordering/reconnect/browser catch-up tests passed. |
| B4: corrupt or old configuration | Missing top-level keys inherit safe defaults. Invalid configuration blocks normal edits behind an explicit recovery dialog. Recovery preserves the exact original file in a uniquely named private backup before writing defaults. | `crates/gyro-core/src/config.rs`; native `app/config.rs`; `App.tsx`; `config-recovery-dialog.tsx` | 21 configuration tests passed, including missing keys, corrupt-file refusal, exact backup bytes, and successful recovery. Dialog native interaction remains unverified. |
| B5: silently lost workbench settings | Acknowledge both appearance and workbench writes; retain failed writes for retry. Surface the failure in notifications and every Settings section with a retry action. | `app-state.tsx`; `App.tsx`; `packages/ui/src/surfaces.tsx` | Actual flush-helper tests passed for partial quota failure, retained pending writes, and successful retry. |

## Speed

| Finding | Implemented change | Measured or expected result |
|---|---|---|
| P1: metadata fetches on every token | Token events update live state locally. Metadata is reused for ten seconds; remaining invalidations are throttled. Sidebar polling is reduced and refreshed by start/completion events. Unchanged running state retains its React object. | Continuous token streams no longer cause the previous roughly 25 workspace RPC/s. No end-to-end CPU/React profiling claim. |
| P2: serialized input and one-second output polling | Coalesce ordered input, reuse recent authority, and push PTY output after a 50 ms batching window. Send cursor deltas only to the owning device; cursor gaps trigger a full read. Old hosts retain polling compatibility. | Controlled 50 ms RTT: 20 inputs took 113–133 ms including the claim, versus the audit's 1,037 ms (about 87–89% faster). This is a client benchmark, not WAN latency. |
| P3: repeatedly hash unchanged dirty files | Cache bounded file hashes against identity, size, mtime, and nanosecond ctime; verify metadata around reads. Keep fresh Git status and mutation revision checks. | Unchanged cache hits skip file-content reads. Same-size edits with restored mtime invalidate the cache. No disk wall-time claim. |
| P4: synchronously save all remote buffers per edit | Debounce ordinary view writes by 250 ms; persist changed editor buffers through IndexedDB. Keep the small view in localStorage and flush pending submit receipts before sending. Wait for storage hydration when creating and immediately submitting a chat. | Real browser migrated/restored a 4 MiB legacy buffer across reload; small localStorage view stayed below 1 KiB. Host isolation and deletion without resurrection passed. |

## Validation

- `cargo test --locked -p gyro-remote`: 38 passed; one existing actual-OpenSSH test ignored because it requires an sshd setup. Includes a real transport test proving another device's terminal output is not delivered.
- `cargo test --locked -p gyro-core config::tests`: 21 passed.
- `cargo test --locked -p gyro-core --lib keychain::`: 10 passed; synthetic credentials only.
- `cargo test --locked -p gyro-desktop --lib features::remote_access::`: six passed.
- Desktop TypeScript check passed using the installed compiler directly. The pnpm wrapper attempted an unrelated dependency reinstall and was not used further.
- Remote client, remote media, settings upgrade, appearance persistence, provider stream ordering, and new settings/remote regression scripts passed.
- `scripts/check-remote-storage-browser.mjs` passed with real IndexedDB in a disposable browser profile.
- `scripts/check-remote-access-browser.mjs` passed against a frozen production-component fixture: pairing/settings, new/existing chat, first submit, image uploads, command chronology, file conflicts, Git, terminal, reconnect, machine switching, focus and narrow/light layout. Artifacts: `/private/tmp/gyro-settings-static-browser/result.json` and sibling screenshots.
- A normal native executable build passed. Subsequent rebuilds hit disk pressure generating the static archive; the final smoke executable was built from the current library with `cargo rustc --locked -p gyro-desktop --lib --crate-type rlib` and linked to the existing main entry point. Only superseded generated artifacts from this verification run were removed; no source changes were made to work around the build.
- Native smoke passed on the latest code: 23 base checks, 14 existing regressions and six new checks for invalid-name OFF, repeated OFF, disabled-runtime refusal, late cleanup without rebind, audit records and PTY output push. Output arrived in 54 ms in this single loopback sample (no rendering/WAN). Report: `/private/tmp/gyro-settings-native-final.YjeSLF/remote-smoke.json`.

No physical two-Mac, WAN/relay latency, hardware sleep/wake, live provider, installed-app upgrade, or real user Keychain migration acceptance is claimed.

## UI review

Production SettingsGroup/SettingsRow/SettingsStatus, existing buttons, existing dialog styling and semantic colors are reused; no new palette or layout system. Source review passed for action hierarchy, labels, busy/error states and native-dialog focus containment. Browser evidence covers Remote access loading/empty/error/connected/offline states and keyboard focus. Populated audit records, configuration recovery dialog interaction and persistence-error retry in the installed app remain unverified visually; their backing logic has automated coverage above.
