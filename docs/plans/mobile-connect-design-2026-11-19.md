# Connecting the Gyro mobile app — end-to-end design

Draft, 19 November 2026. Status: proposal, nothing built.

## Goal

From an iPhone, a user can pair with their Mac running Gyro in under a minute, then:

- see their projects and running chats,
- follow a run live,
- answer approvals and questions,
- send a prompt or stop a run,
- get a notification when a run needs them or finishes.

The Mac stays the execution host. Provider keys, files, terminals and models never leave it. The phone is a trusted remote, like the second Mac in today's Remote access feature.

## What we already have (and reuse)

| Existing piece | Where | Reuse on mobile |
| --- | --- | --- |
| Iroh QUIC transport, ALPN `gyro/remote/v1`, direct + relay fallback, mDNS on LAN | `crates/gyro-remote/src/transport.rs` | Same transport. The phone is another Iroh node. |
| Invitation: 32-byte secret, 5 min, single use, `gyro-pair-v1:<base64 json>` | `store.rs::invite`, `remote_access/commands.rs` | Same invitation, shown as a QR code. |
| Host approval of pending device + fingerprint compare | Settings → Remote access | Same approval, with "iPhone" device kind shown. |
| Typed operation allowlist (`Hello`, `Projects`, `Sessions`, `Snapshot`, `Watch`, `Submit`, `Stop`, `Approval`, `Question`, `Claim`…) | `protocol.rs` | The phone uses a subset. |
| Controller lease + generation fencing, mutation receipts, snapshot catch-up | `control.rs`, `store.rs` | Exactly what a flaky mobile link needs. |
| Gyro Cloud (Supabase accounts, Cloudflare Worker, E2E chats) | `services/gyro-cloud` | Hosts the push relay later; optional for pairing. |

Not in scope today, and called out in the remote-access plan: mobile clients, a background daemon, waking a sleeping Mac.

## Architecture decision

**Native SwiftUI app with a shared Rust core via UniFFI.**

- `crates/gyro-remote` (client half) compiles to an iOS XCFramework. Pairing, framing, receipts and the protocol stay in one Rust implementation, so the phone cannot drift from the host.
- A thin `crates/gyro-mobile-ffi` crate exposes an async, mobile-shaped API: `pair(invitation)`, `connect(host)`, `sessions()`, `watch(session) -> stream`, `submit`, `approve`, `stop`.
- SwiftUI for the UI. Chat output is markdown, tool cards and diffs, which native views handle well. We do not try to run `packages/ui` in a webview: it is built for a desktop workbench (Monaco, xterm, a large sidebar).

Alternatives considered and rejected for v1: React Native (it would need its own Iroh binding anyway, and we get little UI reuse); a web/PWA client (no Iroh in the browser without a WebSocket gateway, and weak push support on iOS).

Android follows later on the same FFI crate with a Kotlin/Compose UI.

## The connect process, step by step

### 0. Prerequisites shown in the app's empty state
"Gyro on your Mac (v0.1.7+) with Remote access turned on." Includes a link to download Gyro and a short 3-step explainer. No account is needed.

### 1. Host: start pairing
Settings → Remote access → **Connect a phone**.

- If hosting is off, the button turns it on, after the user picks which projects to share (the same project-scope step as today).
- The host creates an invitation as it does today, but **with `address` filled in** (endpoint id + LAN IPs + relay URL) so the first dial is fast.
- It shows:
  - a **QR code** of `https://gyro.app/pair#gyro-pair-v1:…`. The secret goes in the fragment so it is never sent to a server, and a universal link opens the app directly from the iOS Camera.
  - a countdown (5:00) and **Regenerate**.
  - **Copy code** as a fallback (for pasting the code via AirDrop or Notes).

### 2. Phone: scan
First launch → **Connect to your Mac** → camera scanner (with a **Paste code** fallback).

1. Parse and validate the invitation locally: version, expiry, and the address id must match `host_id`.
2. Generate the phone's Iroh identity (once, stored in the Keychain as `ThisDeviceOnly`, excluded from backups).
3. Dial the host with the address hint (LAN direct first, relay fallback).
4. Send a pair request with name = the device name the user can edit (for example "Wytze's iPhone") plus `kind: ios`.
5. The phone shows a **"Confirm on your Mac"** screen with a 6-word fingerprint (derived from both endpoint ids).

### 3. Host: approve
A system notification plus an in-app sheet: "**Wytze's iPhone** wants to connect. Fingerprint: *amber · river · …*" → **Allow** / **Deny**.

- The sheet shows what a phone can do by default (see Permissions), with a toggle row for each permission.
- Allowing stores the peer with `role: client`, `kind: ios` and its permissions.

### 4. Phone: connected
The phone polls `PairStatus` (as the desktop client does), sees approval, saves the host (id, name, last address) and opens the **Projects** screen. It then asks for notification permission, with context first: "Get notified when Gyro needs an approval."

The whole flow is two taps on the Mac, a scan, and a confirm.

### 5. Every later connection
- On launch or foreground: connect to saved hosts in parallel → `Hello` → `Projects`/`Sessions`. Use mDNS on the same Wi-Fi, and the relay elsewhere.
- Open a chat → `Snapshot` + `Watch`. Live events stream in, and the snapshot covers whatever was missed.
- Send a prompt / approve / stop → claim control if needed (`Claim`/`RequestControl`), then mutate with a receipt UUID. On reconnect, reconcile receipts before allowing a resend (existing behavior).
- Going to the background closes the stream within iOS limits. Nothing on the host stops, and runs continue.

### 6. Unpair / revoke
- Phone: Host → **Forget this Mac** (deletes the saved host and tells the host if reachable).
- Mac: Trusted devices → **Revoke** (existing). The phone gets "This Mac removed access" on the next connect and returns to the pairing screen.
- Lost phone: revoke from the Mac. Optional Face ID lock in the app limits exposure meanwhile.

## Screens (v1)

1. **Welcome / Connect** – scanner, paste code, "How it works".
2. **Confirm on Mac** – fingerprint, spinner, cancel, expiry handling.
3. **Hosts** (only if more than one Mac) – online/offline, last seen.
4. **Projects → Chats** – status chips: Running, Needs you, Done, Failed.
5. **Chat** – streamed transcript, tool cards collapsed, diff summary, approval/question cards inline, composer with model picker (models come from the host), Stop.
6. **Needs you** inbox – all pending approvals/questions across projects.
7. **Settings** – device name, Face ID lock, notifications, hosts, about.

Out of v1: file editing, terminals, Git mutations, browser/preview.

## Permissions per device

The desktop treats every paired device the same today. Phones get a narrower default, which the host can change:

| Permission | Phone default | Operations |
| --- | --- | --- |
| View projects & chats | on | `Projects`, `Sessions`, `History`, `Snapshot`, `Watch` |
| Send prompts & stop runs | on | `Submit`, `Stop`, `CreateSession`, `SetModel`, control ops |
| Answer approvals & questions | on | `Approval`, `Question` |
| Read files & diffs | on | `Files`, `ReadFile`, `Git{Status,Diff}` |
| Edit files, Git writes | off | `WriteFile`, `Path`, Git mutations |
| Terminals | off | `Terminal` |

The host enforces this in `features/remote_access/dispatch.rs` from the peer's stored permissions, never from what the client claims.

## Notifications (the hard part)

iOS kills sockets in the background, so "needs approval" can only reach a locked phone through APNs. That requires a small server.

**Design: blind push relay**

1. At pairing, the phone sends its APNs token plus a per-device symmetric key over the encrypted Iroh channel (new op `RegisterPush`).
2. On an event (approval needed, question, run finished/failed), the host encrypts a small payload `{sessionId, kind, title}` with that key and POSTs `{apnsToken, ciphertext}` to `push.gyro.app` (a new route on the gyro-cloud Worker).
3. The Worker forwards it to APNs with `mutable-content: 1` and a generic alert ("Gyro needs you").
4. A Notification Service Extension on the phone decrypts the payload and rewrites the text ("Approve `rm -rf build` in gyro-website?"). Tapping it deep-links to the chat.

The relay sees only an APNs token, ciphertext, and timing. No account is required. The host authenticates to the relay with a per-host token issued at first registration, and is rate-limited.

Actionable notifications (Approve / Deny from the lock screen) are a v1.1 candidate. They need a foreground connection, so the action opens the app, connects, and sends the decision. They also need Face ID for anything destructive.

Live Activities for a running task are a later candidate.

## Host availability

The most common failure will be "my Mac is asleep." Mitigations:

- **Keep awake while a run is active** (power assertion, on by default when a phone is paired); show it in the menu bar.
- An optional "Keep Mac awake while a phone is paired" setting (off by default; battery warning on laptops).
- The phone shows a truthful offline state: "MacBook Pro is offline · last seen 14:02 · it may be asleep or Gyro is closed." No fake retries. We cannot wake a Mac over the internet in v1.
- Later: the background daemon (already on the roadmap as out-of-scope) would let the host survive closing Gyro.

## Protocol and host changes

`Operation` uses `deny_unknown_fields`, so we must not add fields to `Pair` (old hosts would reject them). Instead:

- Bump to a new invitation version only if the format changes. Keep `gyro-pair-v1` and add a **new op `PairDevice { secret, name, kind, appVersion }`**. A host that does not know the op answers with an error, and the phone shows "Update Gyro on your Mac."
- `Hello` response gains `protocolVersion` + `capabilities` so the phone can hide features the host lacks.
- New ops: `RegisterPush { token, key, environment }`, `UnregisterPush`, `Inbox` (all pending approvals/questions across sessions).
- History pagination with small pages and truncation of large tool output for mobile (`Snapshot { maxBytes }`). The current 8 MiB frame is too big for a phone on cellular.
- Store: `peers` gains `kind`, `permissions`, `push_token`, `push_key`, `last_seen`.
- Host UI: QR rendering, a "Connect a phone" entry, device kind icons, a permission editor per device, last seen.

## Security notes

- Same trust model as Mac pairing: a paired phone can drive coding agents that run with the host user's OS access. The approval sheet says this plainly.
- The QR secret is single use, expires in 5 minutes, and is compared in constant time (existing). The fragment-based URL keeps it out of server logs.
- Phone identity key: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synced. Reinstalling or using a new phone means re-pairing.
- Optional Face ID lock to open the app. Face ID is required for approvals tagged destructive (configurable).
- The push relay is blind (above). APNs tokens are deleted on revoke.
- App Store: the app is a remote control for the user's own computer, and nothing is executed on the device. That framing matters for review (guideline 2.5.2).

## Error states to design

| Situation | Phone shows |
| --- | --- |
| QR expired / already used | "This code expired. Show a new one on your Mac." + rescan |
| Host denies | "Your Mac declined the request." |
| Host too old | "Update Gyro on your Mac to connect a phone." |
| Can't reach host during pairing | "Can't reach your Mac. Make sure Gyro is open and Remote access is on." |
| Host offline later | Offline banner with last seen; cached chat list stays readable |
| Revoked | Back to the pairing screen with an explanation |
| Another device holds control | "Controlled on MacBook Pro" + **Request control** |
| Uncertain mutation after a drop | "Not sure this was sent. Checking…" → reconcile via receipts |

## Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **M0 · Spike** (1 wk) | Build `gyro-remote` for `aarch64-apple-ios`, UniFFI wrapper, a bare SwiftUI app that pairs via pasted code and lists projects | Real iPhone pairs with a real Mac over LAN and over cellular (relay) |
| **M1 · Pair + watch** | QR on host, scanner, `PairDevice`, device kinds/permissions, projects/chats/live transcript, offline states | Pair in <60 s; watch a live run; reconnect after background |
| **M2 · Control** | Composer, model picker, stop, approvals/questions, Needs-you inbox, control handoff | Full loop: prompt from the phone → approve → done, with no duplicate submits under network toggling |
| **M3 · Notifications** | `RegisterPush`, push Worker route, service extension, deep links, keep-awake during runs | Locked phone gets a readable approval notice within 5 s; relay logs show ciphertext only |
| **M4 · Beta** | Face ID lock, polish, accessibility, TestFlight, privacy label, docs | 10 external testers across networks for a week |
| Later | Actionable notifications, Live Activities, Android, account-based host discovery via Gyro Cloud, background host daemon | — |

## Open questions

1. iOS first and Android later? (assumed yes)
2. Is a native SwiftUI client acceptable, given that it means a second UI codebase? (recommended)
3. Should the push relay live on the existing gyro-cloud Worker, or on a separate `gyro-push` Worker? (recommended: a separate Worker, so it has its own keys and rate limits)
4. Pricing: is the mobile app free with Gyro, or tied to a Gyro Cloud plan? The relay has small but real costs.
5. Should a phone be able to start new chats/worktrees in v1, or only continue existing ones?
