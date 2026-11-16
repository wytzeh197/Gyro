# Remote session continuity — 14 November 2026

Remote sessions now use Gyro's existing new-session surface and folder picker. The separate remote start form and sidebar New chat action have been removed. Choosing a remote folder carries the typed prompt into that host's normal composer; Send creates the session and submits on the selected host. Local and remote identities remain separate even when project paths and session IDs match.

Opening a host-started run subscribes to its current output, catches up from the host's bounded live buffer, and continues rendering text, commands, context measurements, and token frames. Catch-up is requested only when opening/reopening a subscription, rather than being retransmitted with every refresh. Sequence ordering removes overlap between catch-up and live delivery. Every listed remote chat receives its actual host running state through the catalog refresh (2.5-second interval); the selected chat streams live.

Connected, trusted devices can act by default. The Environment card no longer contains Take control, Request control, transfer actions, or watching notices. Explicit writes coordinate authority automatically, while generation fencing still rejects delayed writes from a superseded device. Watching and background refreshes do not acquire authority. Stop and new messages after a run work without an additional control action. The host's Full access and approval settings are reflected in the composer.

Host snapshots supply provider plan windows and session usage totals. Live context/token frames use the same presentation handlers as local chats. Opening the usage meter no longer invokes the unsupported-action error. Missing provider measurements remain unknown, rather than being filled with invented estimates of plan allowance.

## Remote identity storage

The device key uses Gyro's existing private local secret store, with owner-only permissions, atomic writes, and cross-process locking. New identities do not use login Keychain. A previous identity is copied only through the existing isolated, noninteractive helper; migration never requests a password sheet, modifies Keychain access rules, or silently replaces a denied key.

This uses the same file-based storage protection as Gyro's current provider credentials, rather than Keychain encryption. If macOS refuses to release an existing legacy identity, enabling remote access reports the migration error and leaves existing pairing data intact. That case still needs a deliberate one-time recovery; silently bypassing macOS protection or generating a replacement would break the trusted identity. Apple documents the distinction between disallowing authentication UI and obtaining access to the item: [authentication UI failure behavior](https://developer.apple.com/documentation/security/ksecuseauthenticationuifail).

## Screen review

| Check | Result and evidence |
| --- | --- |
| Actual components/tokens | Pass, source and browser. Reuses ChatSurface, Composer, ChatContextSection/ComposerPopover, SessionSidebarRow, and the Environment card. No new CSS or visual token values. |
| Loading, empty, error | Pass in source; existing-chat offline/reconnect exercised in the browser. Connecting, no shared projects, unavailable host, and failed submission retain explicit states. New-session no-project and initial offline states were not separately exercised. |
| Honest status | Pass in browser fixture. Two independent running host chats, live text/command updates, Stop, catch-up after navigation, and provider-measured context/plan usage. These are simulated host events, not live-provider evidence. |
| Action hierarchy | Pass, source and rendered screenshots. Standard Send/Stop; no separate Start chat or Take control action. |
| Status colors | Pass in affected scope. Remote folder markers are neutral; existing working indicators, Full access styling, and usage warnings come from the real shared components and state. |
| Keyboard/focus | Pass in browser fixture. Remote folder receives visible keyboard focus; Escape closes the picker and restores its trigger. Existing Environment detail Escape/focus checks also pass. |
| Identity and routing | Pass in client and Rust tests. Catch-up ordering, host/session/watch isolation, stale write fencing, bounded buffers, private file storage, failed migration preservation, and atomic identity creation. Native Keychain migration itself is unverified. |

## Validation

- `pnpm -r typecheck` — passed.
- `pnpm --filter @gyro-dev/desktop build` — passed; existing bundle-size warnings remain.
- `cargo check --locked -p gyro-desktop` — passed, with existing unrelated warnings.
- `cargo test --release --locked -p gyro-remote --lib` — 17 passed.
- `cargo test --release --locked -p gyro-core keychain:: --lib` — 8 passed.
- `node --experimental-strip-types scripts/check-remote-access-client.mjs` — passed.
- `node --experimental-strip-types scripts/check-composer-context-usage.mjs` — passed.
- UI token and sidebar project grouping checks — passed.
- `node scripts/check-remote-access-browser.mjs` — passed, no browser exceptions. Includes local → remote folder selection with a typed draft, standard remote session creation/submission, two active chats, catch-up after switching, Stop, usage, file conflict recovery, Git, terminal, offline/reconnect, and narrow/light rendering.

Browser screenshots and the fixture result are in `artifacts/remote-session-sync-2026-11-14/` (ignored local artifacts):

- `new-session-remote-dark.png`
- `project-picker-remote.png`
- `live-host-chat.png`
- `remote-usage-tooltip.png`
- `workspace-light-900.png`
- `result.json`

No installed app was replaced, no commit was created, and nothing was pushed. Two physical Macs, native Keychain migration, and live-provider execution across the pair remain unverified. Both Macs need the updated implementation for the new control behavior and catch-up support. The live catch-up buffer retains the current turn within 2,048 frames/1 MiB per session and 16 recent sessions; durable history remains authoritative.

## Proposed Gyro rule

Remote execution should reuse the normal session, composer, and project-selection flow, with host identity shown as context and trusted-device coordination handled automatically. The reason is continuity: choosing another Mac should preserve the familiar chat workflow. This is a proposal only; shared AGENTS.md and skill instructions were not changed.


## Local installation and publication — 14 November 2026

The remote-session patch was exported from the Git index and built separately from the pending browser, workflow, and expandable Environment-card changes. The isolated TypeScript, client, and complete remote browser checks passed. The Apple Silicon native bundle built successfully with local compilation overrides (release LTO disabled, 16 codegen units, and opt-level 0 for gyro-core/gyro-desktop); repository build profiles were not changed.

Installed and reopened `~/Applications/Gyro.app`. Its ad-hoc signature passed strict verification. The previous bundle and a consistent private data backup were retained outside the repository. All 217 original session IDs and 733 original session files remained, and the configuration file was unchanged immediately after launch.

Native testing confirmed the migration limitation on this Mac: macOS refused noninteractive access to the old device identity. Settings reports that the identity is protected, and Remote access cannot start with that legacy key. The existing MacBook trust and both shared project records remain intact; no key or pairing was reset. Recovery requires either one explicit Keychain approval to preserve that identity, or a fresh private-storage identity and re-pairing. No password sheet was opened by the migration code. The user has not authorized either recovery action.

This verifies installation and data preservation, not a successful two-Mac remote run. The MacBook also needs the updated implementation for the new UI and automatic coordination behavior.
