# Companion browser ownership — 2026-11-08

Closing a companion Browser now uses its pane's current chat record. The old
handler decoded `session:<id>` from the pane key, or fell back to the active
chat. Pane keys deliberately survive draft migration and session replacement,
so that could close another chat's browser or an obsolete browser.

## Reproduction and fix

The new checks execute the actual `companionSurfaceProps` App callback with
layouts produced by the real chat-grid reducer. Four cases failed before the
repair: draft-to-chat migration, replacing a chat while keeping its pane key,
closing an unfocused draft, and a late close from a removed pane. Ordinary chat
and solo controls passed. All ten combined draft/ownership cases pass after the
repair. See `pane-close-baseline.json` and `pane-close-after.json`.

The handler now reads the current slot. Drafts resolve to their workbench
browser, durable chats to their current UUID, and a missing slot does not close
an active browser. The new script is available as `pnpm test:browser-draft` and
is included in `test:reliability`.

The pass also removes Tauri's unused Web Notification shim from macOS startup.
The cached `tauri-plugin-notification` 2.3.3 initialization script automatically
probed an IPC permission these views do not have, producing the rejection seen
in the prior native review. Gyro's macOS notification permission and delivery
code already uses its native implementation. The plugin remains registered on
other platforms. No notification capability or OS permission was added.

## Native ownership review

The guarded normal-App review gained an explicit `--seed-chats` mode. It creates
two synthetic conversations, Alpha and Beta, only after the immutable temporary
store guard succeeds. Both transcripts say that no provider turn ran. Repeating
the mode reused the same two chat IDs. This is fixture data, not model output.

The ordinary sidebar hides chats in transient workspaces, so the native review
opened these chats through the App's normal search. No sidebar filter was changed.
The review observed:

- Alpha opened its own companion browser at the Original fixture URL.
- Beta opened a distinct Second URL and reached “Clicks: 2.”
- Beta's 1280 × 800 screenshot appeared in Beta's composer.
- Returning to Alpha showed its Original document and no Beta attachment.
- Alpha was changed to “Clicks: 1.” After Beta's Browser tab closed, Alpha still
  showed its Original document, “State: changed” and “Clicks: 1.”

The loopback server recorded one Original and one Second page request across
these switches. Alpha was therefore preserved without a reload. The final
store had exactly two fixture chats, zero prepared Alpha images, one prepared
Beta image and zero rows in all five inspected provider tables. The capture and
prepared Beta image decoded to 1280 × 800 with identical pixels. See
`native-store-audit.json` and `native-final-manifest.json`.

![Beta's own screenshot and composer attachment](/Users/wytze/Gyro/docs/performance/2026-11-08-browser-chat-isolation/beta-capture.png)

![Alpha's retained page after closing Beta](/Users/wytze/Gyro/docs/performance/2026-11-08-browser-chat-isolation/alpha-after-beta-close.png)

## Validation

| Check                                                   | Result                                  | Evidence                                                                      |
| ------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| Actual App draft and close callbacks                    | 10 passed; four new failures reproduced | `pane-close-baseline.json`, `pane-close-after.json`, `pane-close-package.log` |
| Existing browser event/IPC routing                      | 21 cases passed                         | `browser-routing.log`                                                         |
| Rust browser regression tests                           | 59 passed                               | `browser-tests.log`                                                           |
| Native notification logic tests                         | 8 passed                                | `notifications-tests.log`                                                     |
| Companion state and exhaustive chat-grid drop contracts | Passed                                  | `companion-state.log`, `grid-state.log`                                       |
| Desktop TypeScript                                      | Passed                                  | `typecheck.log`                                                               |

Rust tests used an explicit temporary `GYRO_TEST_DATA_DIR`, recorded in
`rust-tests-manifest.json`. The native executable was unchanged during review.
Before and after review, open database/socket paths belonged to the pinned
temporary store. No provider account was connected and no provider turn was
dispatched. The app and fixture server were stopped. No installed app, release,
commit or push was made.

These are focused checks; the complete `test:reliability` suite was not rerun.
For another native review, run `node scripts/run-browser-shell-review.mjs
--seed-chats` and use the printed temporary app, fixture URL and synthetic chats.

## Remaining acceptance work

This is a conditional companion-ownership result. On the first open, the native
companion was present in accessibility but visually blank; its browser reported
a 1% fitted viewport. Opening the native inspector resized the App and restored
the panel. A later read showed a settled 570-pixel panel, opacity 1 and no active
animations. Reopening and switching companions then worked. The cause of that
initial reveal failure is not yet isolated. Its baseline is `alpha-companion.png`
and `.txt`; it must be repaired and retested without relying on a resize.

The macOS console no longer showed the notification permission-probe rejection.
Clicking the custom title region instead exposed an unhandled
`window.start_dragging not allowed` rejection. The main-window capability needs
review. Actual OS notification delivery was not exercised.

Simultaneous split acceptance remains unverified. The usual sidebar drag source
is hidden for these temporary fixture projects, and the New Session menu did
not expose a split action. A supported visible fixture project or restored
layout is still needed; the companion switch test is not proof of split behavior.
Draft migration and replacement close behavior currently has actual-callback and
reducer coverage, not a live first-provider-turn test.

The existing AppShell, ChatSurface, companion host and BrowserPreviewSurface
were used with their real `--gyro-*` styles. No product visual values changed.
Populated/captured states and chat-specific attachment ownership were verified;
first reveal failed; full keyboard traversal is unverified. The native hardware
scope remains macOS 26.2, backing scale 1. Retina, window/display transitions and
older WebKit/private-inset API compatibility still need acceptance. Live model
speed/task-success comparisons still await the additional authorized usage
budget. The broader optimization goal remains active.
