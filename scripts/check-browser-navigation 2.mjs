import assert from "node:assert/strict";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

let state = createInitialWorkbenchState();
const act = (action) => {
  state = workbenchReducer(state, action);
};
act({ type: "browser-close" });
act({ type: "browser-navigate", url: "https://example.com/start" });
act({ type: "browser-loaded", url: "https://example.com/home" });
assert.deepEqual(state.browserPreview.history, ["https://example.com/home"]);
assert.equal(state.browserPreview.status, "ready");
// Links followed inside the page must enable Back, including for agent actions.
act({ type: "browser-loaded", url: "https://example.com/second" });
assert.equal(state.browserPreview.historyIndex, 1);
act({ type: "browser-back" });
act({ type: "browser-loaded", url: "https://example.com/home" });
assert.equal(state.browserPreview.historyIndex, 0);
assert.equal(state.browserPreview.history.length, 2);
act({ type: "browser-forward" });
act({ type: "browser-loaded", url: "https://example.com/second" });
assert.equal(state.browserPreview.historyIndex, 1);
act({ type: "browser-reload" });
act({ type: "browser-loaded", url: "https://example.com/second" });
assert.equal(state.browserPreview.history.length, 2);
assert.equal(state.browserPreview.status, "ready");
act({ type: "browser-back" });
act({ type: "browser-loaded", url: "https://example.com/home" });
act({ type: "browser-loaded", url: "https://example.com/third" });
assert.deepEqual(state.browserPreview.history, [
  "https://example.com/home",
  "https://example.com/third",
]);
console.log(
  "Browser navigation: redirect, page link, back, forward, reload, and history branch passed",
);

// Each native webview owns its state. Late results from A must not replace B.
state = createInitialWorkbenchState();
const sessionAct = (sessionId, action) =>
  act({ type: "browser-session", sessionId, action });
sessionAct("chat-a", {
  type: "browser-navigate",
  url: "https://a.example/",
  background: true,
});
sessionAct("chat-b", {
  type: "browser-navigate",
  url: "https://b.example/",
  background: true,
});
sessionAct("chat-b", { type: "browser-loaded", url: "https://b.example/" });
const b = state.browserPreviewsBySession["chat-b"];
sessionAct("chat-a", {
  type: "browser-loaded",
  url: "https://a.example/redirect",
});
sessionAct("chat-a", { type: "browser-title", title: "Page A" });
sessionAct("chat-a", { type: "browser-device", device: "mobile" });
const capture = {
  path: "/tmp/a.png",
  filename: "a.png",
  width: 800,
  height: 600,
  createdAt: "2026-09-27T12:00:00Z",
};
sessionAct("chat-a", { type: "browser-capture-success", capture });
assert.equal(state.browserPreviewsBySession["chat-b"], b);
assert.equal(state.browserPreviewsBySession["chat-a"].title, "Page A");
assert.equal(state.browserPreviewsBySession["chat-a"].latestCapture, capture);
assert.equal(state.browserPreview.url, "");
assert.equal(state.preferences.activeChatPanel, undefined);
sessionAct("chat-a", {
  type: "browser-loaded",
  url: "https://a.example/second",
});
sessionAct("chat-a", { type: "browser-back" });
assert.equal(state.browserPreviewsBySession["chat-a"].historyIndex, 0);
assert.equal(state.browserPreviewsBySession["chat-b"], b);
sessionAct("chat-a", { type: "browser-close" });
assert.equal(state.browserPreviewsBySession["chat-a"].url, "");
assert.equal(state.browserPreviewsBySession["chat-a"].latestCapture, undefined);
assert.equal(state.browserPreviewsBySession["chat-a"].nativeHost, false);
assert.equal(state.browserPreviewsBySession["chat-b"], b);
console.log(
  "Browser sessions: interleaved navigation, late title/capture, device, history and close remain isolated",
);
