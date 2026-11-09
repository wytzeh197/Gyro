# Native browser interaction selects its chat

A real coordinate click reproduced a focus mismatch: after selecting Beta's
composer, clicking Alpha's native page changed Alpha to `Clicks: 1` and moved
keyboard focus into its WKWebView, while Gyro still marked Beta current.
`native-click.png` / `.txt` and `before-layout.jsonl` record that failure.

The macOS viewport container now reports a mouse-down hit inside its native
child, using the event's window, position and identity. Repeated hit tests for
one event are deduplicated. The owning browser lease emits an interaction only
for its current, visible, non-background resource. The frontend rejects a
superseded resource ID, ignores missing/maximized-away panes and selects the
matching durable chat or draft using the existing `focusChatPane` path.

The native signal does not depend on page JavaScript or add an external-page
IPC permission. Listener cleanup handles an unmount that occurs while native
event subscription is still pending. The callback ref tracks current panes
without resubscribing on every App render.

## Verified

- The normal App was split by dragging Beta's real sidebar row beside Alpha.
  All review launches used the guarded binary and its pinned disposable store.
- After selecting Beta's composer, a coordinate click in Alpha's page selected
  Alpha and changed its page state. After selecting Beta again, a coordinate
  click in Alpha's form selected Alpha again. Native form typing retained focus
  and produced `Project name: Alpha focused` (`native-after.png` / `.txt`).
- `after-layout.jsonl` records the final Alpha companion in `is-current-pane`;
  the prior trace leaves it `is-subdued-pane`. No JavaScript errors were recorded.
- An initial observer using current physical button state missed rapid input.
  The verified version uses the mouse-down event itself. The initial frontend
  type check also caught a resource-field mismatch; the final code uses the
  reducer's actual `nativeResourceId` and passes TypeScript.
- Eight checks execute the actual App routing callback, covering current/stale
  resources, removed and maximized-away panes, migrated pane IDs and drafts.
  Run `pnpm test:browser-interaction`; it is included in `test:reliability`.
- The focused Rust browser suite passes 59 tests with a fresh, explicit temporary
  test store. Browser event-routing, pane-visibility, host-bounds and host-visibility
  checks pass. The full reliability suite was not run.
- The final native process exited. Its store audit has zero rows in all five
  provider-turn/accounting tables. No paid provider calls ran.

## Remaining acceptance

This proves pointer-driven chat selection and native typing on macOS 26.2 at
backing scale 1. Right/middle clicks have a source path but were not exercised.
Keyboard shortcuts originating inside a native page, maximized/restored layouts,
native close lifecycle after this observer change, Retina and older WebKit still
need acceptance. The advertised Cmd+T shortcut did not open Browser in the
tested initial chat state and needs investigation. Live GPT/Grok task success
and response-speed validation still await additional authorized provider usage.

No component styling or design tokens changed. Native populated page, visible
focus and typed input were inspected; other loading/network-error states were
not re-reviewed in this pass. The overall goal remains active.
