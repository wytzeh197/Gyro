# Chat Browser and native Search shortcuts

Two normal-App failures were confirmed. Cmd+T did not open Browser when the
chat companion was closed: only the mounted companion handled it, while the
global fallback created a terminal. Separately, Cmd+K with keyboard focus in a
native WKWebView did not open Gyro Search, because that key event never reached
the main React window (`native-page-search-failed.txt`).

The App's Cmd+T fallback now opens Browser for the focused chat pane in thread
layout. IDE/terminal-grid behavior and explicit user workspace bindings retain
their existing precedence. Both App and companion handlers respect
`defaultPrevented`, preventing one shortcut from triggering both actions.

macOS now has a native **View → Search Gyro** Cmd+K accelerator, appended to
the existing standard menu. While the main window is focused it sends a
bounded Search event to the main webview. A stable listener calls the latest
existing keyboard handler, so Search works regardless of which child webview
owns keyboard focus. This does not grant external pages a new IPC capability
or install a system-wide shortcut.

## Verification

- Ten checks execute the actual App keyboard handler; all pass and five fail
  against the previous implementation. They cover closed companions, focused
  split panes, folderless drafts, existing terminal layouts, consumed events,
  global Search and explicit user bindings.
- Four checks execute the native event callback: Search dispatch, latest
  handler selection, unknown-key rejection and disposal. Run
  `pnpm test:chat-browser-shortcut`; it is included in `test:reliability`.
- Native Cmd+T opened Browser directly from a closed Alpha companion. After
  navigating and closing that browser, Cmd+T opened a fresh browser and the
  Second fixture page loaded with fresh state (`native-after.png` / `.txt`,
  `chat-shortcut-manifest.json`). This also exercised native close/reopen after
  the interaction observer change.
- In the final native build, a coordinate click focused the WKWebView and
  changed its page to `Clicks: 1`. Cmd+K opened Search. The search field received
  `Browser review`, the native page was hidden while the dialog was open, and
  Escape restored the original document at `Clicks: 1` with only one GET.
  See `native-search-after.png` / `.txt`, `native-search-restored.txt` and
  `native-search-manifest.json`.
- The native build, desktop TypeScript, browser-interaction and browser-draft
  regression checks pass. No JavaScript errors were recorded. The full
  reliability suite was not run.
- Every native launch used the guarded review binary, unique review identity
  and pinned `/private/tmp/gyro-shell-WZRuqH/data` store. Open-file audits
  verified the temporary database boundary. Review processes exited. All five
  provider-turn/accounting tables remain empty; no paid provider call ran.

## Scope

Native evidence is macOS 26.2 at backing scale 1. The Search accelerator uses
AppKit's normal menu and preserves the existing menu items. No design tokens,
component styles or production CSP changed. Search populated/typed state and
browser loading/ready state were observed; other network errors were not
re-reviewed in this pass.

Other companion bindings and shortcuts originating inside native pages still
need a broader matrix, as do maximized/restored layouts, Retina, older WebKit
and native draft/provider flow. Live GPT/Grok task-success and response-speed
validation still await additional authorized usage. The overall goal remains
active.
