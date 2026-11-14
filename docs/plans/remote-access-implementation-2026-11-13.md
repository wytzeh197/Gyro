# Experimental Gyro remote workspaces

Implemented in the working tree on 2026-11-13. This is a desktop-to-desktop prototype, separate from Gyro Cloud, accounts, subscriptions, and chat backups. No hosted infrastructure was provisioned.

## Use

1. Run this build of Gyro on both Macs. On the host, open **Settings → Remote access**, enable access, and choose projects to share.
2. Create an invitation and paste it into Remote access on the other Mac. Invitations expire after five minutes and are single use. Approve the requesting device on the host; compare its displayed fingerprint.
3. Connect to the paired Mac from **Settings → Remote access → Trusted devices**. Remote projects have a small **Remote** label in the sidebar. The normal chat Environment card shows **Remote · device name** beside the host's branch and diff totals; click that label for connection details, refresh, Files, Source Control, Terminal, and **This Mac**. There is no global machine selector.
4. Open a host session or create a new remote chat, optionally in a new worktree. Take control to send prompts, decide approvals, save files, operate Git, and use host terminals. Other devices can watch. The host can explicitly reclaim or transfer control in Settings.
5. Switching machines releases control and retains the remote draft and editor buffers on the client. Disconnecting does not stop an admitted coding run. Use Stop explicitly to stop a run.

Both Macs must be awake and running Gyro. Closing the host window hides it; quitting Gyro or sleeping the Mac makes it unavailable. The prototype does not install a background service or wake sleeping machines.

### Install the testing branch on another Mac

Use the same `v0.1.4` branch on both Macs. This is a local testing build, not a published release; the displayed package version remains `0.1.3`.

Prerequisites: macOS 14+, Xcode Command Line Tools, Rust 1.91 or newer, Node 22 or newer, and pnpm 11 or newer. From your Gyro clone, with any local work saved:

```sh
git fetch origin
git switch v0.1.4
git pull --ff-only origin v0.1.4
pnpm install --frozen-lockfile
pnpm desktop:install-local
```

The local installer replaces and opens `~/Applications/Gyro.app`; it leaves `~/Library/Application Support/Gyro/` in place. It signs using an available local identity, with ad-hoc signing as a fallback. Build separately on each Mac so the binary matches that Mac's architecture. Compare `git rev-parse HEAD` on both clones before testing, then follow the pairing steps above. A source push does not update an installed app automatically.

## Components

| Layer | Implementation |
| --- | --- |
| Transport | `crates/gyro-remote`: Iroh 1.4.1, encrypted QUIC, direct connection with community relay/discovery fallback, typed framed protocol with bounded frames, streams, and timeouts. |
| Device trust | Keychain device identity; private SQLite pairing, shared-project scopes, peers, mutation receipts, and submitted-turn reservations. No identity key is exposed to JavaScript. |
| Host | `features/remote_access`: explicit request allowlist calling existing session, provider, approval, file, Git, and PTY services on blocking workers. It does not expose arbitrary Tauri commands. |
| Control | One renewable controller lease per session, generation fencing, watchers, explicit transfer/reclaim, and local prompt/approval/remote-terminal guards. |
| Frontend | `src/remote-access`: host-bound client and subscriptions, machine-scoped view persistence, shared AppChrome/ChatSurface/Monaco/xterm components, settings and recovery states. |

The existing local App remains its own execution path. Selecting a remote machine mounts a remote workspace with a host-bound transport. A failed remote request never falls back to local execution. Provider/model readiness comes from the host; credentials and execution remain there.

Mutation UUIDs are recorded before execution. A replay of the same UUID returns its saved result; an interrupted request reports uncertainty instead of executing it again. Prompt request/turn IDs survive a client reconnect. The client reconciles history and receipts before allowing another submission, and never silently resends uncertain terminal input.

File saves use content hashes. Source Control mutations require a fresh repository revision. These detect external changes; they do not lock the repository against every local application or shell. A file conflict can be recovered with **Reload from host**, with confirmation before discarding unsaved client text.

## Boundaries

- Remote terminals and coding tools run with the host OS user's access. Shared project selection constrains the remote file/session API; it is **not an OS sandbox**. Only pair trusted devices.
- Native file APIs enforce workspace paths; `.git` editing and path traversal are rejected. Gyro-created worktrees are explicitly scoped to their shared parent project. Removing a share revokes that access and its streams; revoking a device rejects subsequent requests and closes its connections.
- Public community relays/discovery are experimental connectivity, with rate limits and no availability guarantee. End-to-end encryption protects request contents; operators can observe connection metadata. This is not a promise of permanently free production hosting.
- Client-side drafts, transcripts in memory, and saved editor buffers are private to that client profile. Local browser storage can fill; the UI reports persistence failure and retains the current view in memory.
- Remote browser/computer use, debug adapters, local attachment uploads, project synchronization, mobile clients, and a background daemon are outside this prototype. Configure provider accounts and policy on the host.
- Rust minimum is now 1.91 because of Iroh's dependency requirement. No release version was changed.

## Verification

| Evidence | Result and limit |
| --- | --- |
| `cargo test -p gyro-remote --offline` | 7 passed. Covers pairing, receipts/reopen, scope revocation, control fencing, bounded framing, encrypted loopback requests/events, and a local relay test with all direct transports disabled. The relay test does not use the public community relay. |
| `node --experimental-strip-types scripts/check-remote-access-client.mjs` | Passed. Host routing, lease isolation, stale subscriptions, ordered terminal writes, uncertain input handling, corrupt persistence and quota recovery. |
| Debug native smoke | 18 checks passed using the actual desktop services, two isolated loopback nodes, a temporary Git repository/worktree, real PTY output, approval channels, and a deterministic provider fixture. No Keychain, public networking, or model calls. |
| Browser fixture | Passed settings/hosting/invitation, existing chat, controller, prompt response, Monaco files, stale-save rejection/reload, Git diff, xterm, offline/reconnect, machine switch, and light/narrow view. Uses production components with explicit fixture ports; does not prove native pairing UI or real providers. |
| `pnpm -r typecheck` | Passed UI and desktop. |
| Desktop Vite production build | Passed; existing large-chunk warning remains. |
| Command blocking guard | Passed, 214 commands. |
| Existing regression guards | Chat questions, workspace document URIs, and Settings upgrade passed. |
| Broad workbench smoke | Two failures also reproduce when affected sources are replaced in-memory by their pre-task copies: chat layout assertion and an existing diagnostics drag button assertion. No baseline was relaxed. |
| Architecture guard | Blocked by the pre-existing CLI main file at 5610 lines against a 5602-line ceiling. Remote host code was placed in the existing features domain; the lib.rs ceiling was preserved. |

Visual review used the agent-design-system and review-screen checklists:

| Check | Result |
| --- | --- |
| Tokens and components | Pass in source/browser: Gyro semantic tokens and existing settings controls, sidebar, chat, Monaco, and terminal components. |
| Relevant states | Pass in the browser fixture for populated/empty settings, populated workspaces, errors, offline/reconnect, dark/light themes and 900px width. Real native pairing/loading remains unverified. |
| Truthful status | Pass in fixture: status text and disabled controls follow port state; the execution host stays visible. Native cross-network status remains unverified. |
| Action hierarchy | Pass in reviewed fixture: invitation and pairing primary actions are mutually exclusive; project, Git and file actions use existing secondary controls. |
| Focus and keyboard | Source confirms shared focus styles, labeled controls, and modal semantics. Complete native keyboard/accessibility review is unverified. |

The visual review caught and corrected the terminal's stale palette on theme changes. Monaco/xterm now subscribe to theme changes, and the narrow light screenshot shows readable terminal output.

Still required before a public release: two physical Macs over separate networks, public relay/discovery reconnection after restarting either app, actual provider streaming and approvals with an authenticated host, sleep/quit behavior, native Keychain/pairing UX, and packaged/signed app acceptance. No install, deployment, release, commit, or push is implied by these checks.

## Reproduce isolated acceptance

Build with `cargo build -p gyro-desktop --offline`, then run the debug binary with `GYRO_REMOTE_SMOKE=1` and `GYRO_TEST_DATA_DIR` pointing to a **fresh absolute temporary directory**. Its `remote-smoke.json` records the result. The smoke entry point is excluded from release builds.

For browser checks, run Vite from `apps/desktop` on `127.0.0.1:1449`, then run `node scripts/check-remote-access-browser.mjs`. The script opens an isolated headless browser profile and loads only `remote-access-preview.html`. That preview is not an input to the normal production build. Screenshots and its result are written to `/private/tmp/gyro-remote-browser` by default. Socket-based checks need permission to bind localhost in restricted environments.
