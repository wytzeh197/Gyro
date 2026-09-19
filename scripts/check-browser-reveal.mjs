import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isSplitChatLayout,
  resolveBrowserReveal,
} from "../packages/ui/src/browser-reveal.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

// The whole point: a model navigating while two chats are tiled must not take
// a surface. That reveal covered the transcript of a pane the user chose to
// keep open, for a page the model reads through the bridge either way.
assert.deepEqual(
  resolveBrowserReveal({
    isUserInitiated: false,
    isSplitView: true,
    isBrowserVisible: false,
  }),
  { reveal: false, reason: "split-view-background" },
);

// A single chat still reveals: there is one transcript and a free rail, and
// watching the page the model is reading is the point.
assert.deepEqual(
  resolveBrowserReveal({
    isUserInitiated: false,
    isSplitView: false,
    isBrowserVisible: false,
  }),
  { reveal: true, reason: "reveal" },
);

// The user's own action wins in every layout — suppressing a reveal they asked
// for would make the Browser button look broken in a split.
for (const isSplitView of [true, false]) {
  assert.deepEqual(
    resolveBrowserReveal({
      isUserInitiated: true,
      isSplitView,
      isBrowserVisible: false,
    }),
    { reveal: true, reason: "user-initiated" },
  );
}

// Already-open Browser needs no reveal, so a solo chat with the panel up does
// not re-dispatch one and steal focus back from wherever the user moved.
assert.deepEqual(
  resolveBrowserReveal({
    isUserInitiated: false,
    isSplitView: false,
    isBrowserVisible: true,
  }),
  { reveal: false, reason: "already-visible" },
);

// A maximized pane owns the whole grid, so it is a single chat again and
// reveals like one. This mirrors the grid's own isTiled rule.
assert.equal(
  isSplitChatLayout({ occupiedPaneCount: 2, hasMaximizedPane: false }),
  true,
);
assert.equal(
  isSplitChatLayout({ occupiedPaneCount: 2, hasMaximizedPane: true }),
  false,
);
assert.equal(
  isSplitChatLayout({ occupiedPaneCount: 1, hasMaximizedPane: false }),
  false,
);

// A background navigation records the page without claiming a surface. Before
// this flag, browser-navigate itself revealed, so suppressing the explicit
// panel dispatch alone would have changed nothing.
{
  const before = createInitialWorkbenchState();
  const background = workbenchReducer(before, {
    type: "browser-navigate",
    url: "https://example.com/docs",
    background: true,
  });
  assert.equal(background.browserPreview.url, "https://example.com/docs");
  assert.equal(
    background.browserPreview.history.at(-1),
    "https://example.com/docs",
  );
  assert.equal(background.preferences.activeChatPanel, undefined);
  assert.equal(background.isToolPanelOpen, before.isToolPanelOpen);
  assert.equal(background.activeDestination, before.activeDestination);
}

// Without the flag the old reveal is intact, so a solo chat is unaffected.
{
  const thread = {
    ...createInitialWorkbenchState(),
    activeWorkspaceLayout: "thread",
  };
  const revealed = workbenchReducer(thread, {
    type: "browser-navigate",
    url: "https://example.com/docs",
  });
  assert.equal(revealed.preferences.activeChatPanel, "browser");
}

// Both halves have to be wired: the listener must ask for the decision and
// pass it to the reducer, or the model's page would still take the pane.
const listener = readFileSync(
  new URL("../apps/desktop/src/model-browser-reveal.ts", import.meta.url),
  "utf8",
);
assert.ok(
  /resolveBrowserReveal\(\{\s*isUserInitiated: false,/.test(listener),
  "The native browser-opened listener should resolve a reveal decision",
);
assert.ok(
  listener.includes("background: !decision.reveal"),
  "A suppressed reveal should navigate in the background",
);
assert.ok(
  /if \(decision\.reveal\) \{\s*send\(\{ type: "set-chat-panel", panel: "browser" \}\);/.test(
    listener,
  ),
  "The panel should only open when the decision says to reveal",
);
// The layout has to reach the listener, or every navigation would look solo.
const app = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
assert.ok(
  /useModelBrowserReveal\(\{[^}]*occupiedPaneCount:/s.test(app),
  "App should hand the chat layout to the model browser reveal hook",
);

// The backend half: a browser nobody is looking at still needs a real viewport,
// or every background read would see a 1x1 page and every capture would be a
// 1x1 PNG.
const sessionBrowser = readFileSync(
  new URL("../apps/desktop/src-tauri/src/session_browser.rs", import.meta.url),
  "utf8",
);
assert.ok(
  /pub const BACKGROUND_BROWSER_BOUNDS: SessionBrowserBounds = SessionBrowserBounds \{[^}]*width: 1280\.0,[^}]*height: 800\.0,/s.test(
    sessionBrowser,
  ),
  "A background browser should get a desktop-sized viewport",
);
assert.ok(
  sessionBrowser.includes(".unwrap_or(BACKGROUND_BROWSER_BOUNDS)"),
  "An open without bounds should fall back to the background viewport",
);
// Sizing it like a desktop must not also make it visible: visibility now
// follows whether a caller actually asked for bounds on screen.
assert.ok(
  /let visible = request\.visible\.unwrap_or\(\s*requested_bounds\.is_some_and\(/.test(
    sessionBrowser,
  ),
  "Default visibility should depend on requested bounds, not the fallback size",
);

console.log("browser reveal checks passed");
