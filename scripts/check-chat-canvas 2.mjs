import assert from "node:assert/strict";
import { latestCanvasArtifacts } from "../packages/ui/src/chat-canvas.ts";
import {
  chatCompanionReducer,
  createInitialChatCompanionState,
  chatCompanionPane,
} from "../packages/ui/src/chat-companion.ts";

const original = {
  id: "draft",
  kind: "canvas",
  title: "Draft",
  format: "text",
  content: "First version",
};
const revised = { ...original, content: "Revised version" };
const table = {
  id: "comparison",
  kind: "table",
  title: "Comparison",
  columns: ["Option"],
  rows: [["A"]],
};
assert.deepEqual(
  latestCanvasArtifacts([
    original,
    table,
    { id: "cmd", kind: "command", command: "pwd" },
    revised,
  ]),
  [table, revised],
);
assert.equal(
  original.content,
  "First version",
  "History must retain the old version",
);
assert.deepEqual(
  latestCanvasArtifacts([]),
  [],
  "A different empty chat must not inherit canvas content",
);

let state = createInitialChatCompanionState();
for (const action of [
  { type: "focus-pane", paneId: "a" },
  { type: "open-tab", tab: "canvas" },
  { type: "open-tab", tab: "browser" },
  { type: "open-tab", tab: "canvas" },
])
  state = chatCompanionReducer(state, action);
assert.deepEqual(chatCompanionPane(state).openTabs, ["canvas", "browser"]);
state = chatCompanionReducer(state, { type: "focus-pane", paneId: "b" });
assert.deepEqual(
  chatCompanionPane(state).openTabs,
  [],
  "Canvas tabs belong to their pane",
);
state = chatCompanionReducer(state, { type: "focus-pane", paneId: "a" });
assert.equal(chatCompanionPane(state).activeTab, "canvas");
const html = {
  ...original,
  id: "ui",
  format: "html",
  content: "<button>Try it</button>",
};
const htmlRevision = { ...html, content: "<button>Updated</button>" };
assert.deepEqual(latestCanvasArtifacts([html, revised, htmlRevision]), [
  revised,
  htmlRevision,
]);
assert.equal(html.content, "<button>Try it</button>");
console.log("check-chat-canvas: ok");
