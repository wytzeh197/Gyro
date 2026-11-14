# Remote workspace continuity

Connecting to another Mac previously replaced the local App with a remote AppChrome. This hid the connecting Mac's projects and unmounted its active local workspace. The desktop now keeps one AppChrome and the local App mounted, adds host-scoped remote project rows beside the local folders, and displays remote content inside that shell.

## Behavior

- Local chats, folders, layout, and drafts remain on this Mac while remote projects are open. Remote IDs and paths never enter local session, provider, editor, or drag routing.
- Remote folders use the existing folder and chat row components, Remote indicator, and compact more/less controls. The Environment card retains its inline remote indicator and host tools.
- Sidebar project roots are synchronized automatically. Stable roots retain their remote project IDs; removing a root removes its shared access and invalidates affected remote tools.
- Pairing approval grants both directions. Legacy approved inbound clients migrate to reciprocal peers; host records awaiting approval do not gain inbound authorization. Both Macs must enable Remote access.
- Settings receive the invitation's live availability. Consuming or expiring the code dismisses the invitation panel; approval remains a separate explicit action. The joining Mac clears its pending form on approval.
- Workspace cleanup releases only its own control generation. Local global editor shortcuts are inactive while remote content is visible.

## Review

- **Pass, source and browser fixture:** existing Gyro components and semantic tokens; no new palette or visual primitives.
- **Pass, browser fixture:** local/remote folders coexist with identical paths and IDs; local history and draft survive switching; Remote marker stays inline; automatic project discovery; used invitation closes without waiting five minutes; compact remote chat list; offline/reconnect, files, Git, terminal, chat submission, and Environment details keyboard/focus behavior.
- **Pass, source and Rust tests:** single-use invitations, explicit reciprocal approval, migration boundaries, stable project IDs, and removal of shared worktree scope.
- **Native build and local installation:** recorded separately in the delivery message after completion.
- **Unverified:** the new build on two physical Macs and live-provider requests across that pair. Browser evidence is an explicit fixture using production components, not a physical-device acceptance test.

Validation: `pnpm -r typecheck`, `node scripts/check-ui-tokens.mjs`, `node scripts/check-sidebar-project-groups.mjs`, `node --experimental-strip-types scripts/check-remote-access-client.mjs`, `node scripts/check-remote-access-browser.mjs`, and `cargo test --release --locked -p gyro-remote --lib`.

## Proposed project rule

Connecting a device adds host-scoped projects to the existing workspace and preserves local navigation and state. The reason is continuity: opening another Mac should not make this Mac's work disappear. This is a proposed Gyro project rule; shared instructions have not been changed.
