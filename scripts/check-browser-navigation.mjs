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
