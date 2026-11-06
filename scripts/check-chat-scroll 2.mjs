import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createChatScrollMemory } from "../packages/ui/src/chat-scroll-memory.ts";

const memory = createChatScrollMemory(2);
memory.save("one", {
  top: 300,
  height: 1000,
  following: false,
  firstId: "first",
});
assert.equal(memory.restore("one", ["first", "last"], 1000), 300);
assert.equal(memory.restore("one", ["earlier", "first", "last"], 1400), 700);
assert.equal(
  memory.restore("one", ["first", "last", "new"], 1400),
  300,
  "appended activity cannot move the reader",
);
assert.equal(memory.restore("one", ["pruned"], 1000), undefined);
assert.equal(memory.restore("other", ["first"], 1000), undefined);
memory.save("two", { top: 0, height: 1000, following: true });
memory.save("three", {
  top: 200,
  height: 1000,
  following: false,
  firstId: "first",
});
assert.equal(
  memory.restore("one", ["first"], 1000),
  undefined,
  "oldest position is evicted",
);
assert.equal(
  memory.restore("two", ["first"], 1000),
  undefined,
  "following chats still open at latest",
);
memory.clear();

const source = readFileSync(
  new URL("../packages/ui/src/use-chat-transcript-scroll.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
class Transcript {
  constructor(height = 1000) {
    this.scrollHeight = height;
    this.clientHeight = 200;
    this.top = 0;
    this.children = [];
    this.style = { setProperty() {} };
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value) {
    this.top = Math.max(
      0,
      Math.min(value, this.scrollHeight - this.clientHeight),
    );
  }
  querySelector() {
    return null;
  }
}
function mount(sessionId, ids = ["first"], height = 1000) {
  const layouts = [],
    effects = [],
    frames = new Map();
  let frameId = 0;
  const context = {
    exports: {},
    HTMLElement: Transcript,
    Element: Transcript,
    window: {
      getComputedStyle: () => ({ paddingTop: "0", paddingBottom: "0" }),
      requestAnimationFrame: (callback) => {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
    require: (name) => {
      if (name === "react")
        return {
          useState: (value) => [value, () => {}],
          useRef: (value) => ({ current: value }),
          useCallback: (callback) => callback,
          useLayoutEffect: (callback) => layouts.push(callback),
          useEffect: (callback) => effects.push(callback),
        };
      if (name === "./chat-scroll-memory") return { chatScrollMemory: memory };
      throw new Error("Unexpected scroll dependency " + name);
    },
  };
  vm.runInNewContext(js, context);
  const hook = context.exports.useChatTranscriptScroll({
    events: ids.map((id) => ({ id, sessionId, kind: "user-message" })),
    hasMoreBefore: false,
    isLoadingEarlier: false,
    liveChangesTarget: null,
  });
  const node = new Transcript(height);
  hook.transcriptRef.current = node;
  layouts.forEach((callback) => callback());
  const cleanup = effects.map((callback) => callback()).filter(Boolean);
  [...frames.values()].forEach((callback) => callback());
  frames.clear();
  return {
    hook,
    node,
    activityUpdate: () => {
      effects[0]();
      [...frames.values()].forEach((callback) => callback());
      frames.clear();
    },
    unmount: () => cleanup.forEach((callback) => callback()),
  };
}
const initial = mount("one");
assert.equal(initial.node.scrollTop, 800);
initial.hook.onTranscriptWheel({ deltaY: -1 });
initial.node.scrollTop = 300;
initial.hook.onTranscriptScroll({ currentTarget: initial.node });
initial.unmount();
const returned = mount("one");
assert.equal(
  returned.node.scrollTop,
  300,
  "the actual hook restores after page unmount/remount",
);
returned.hook.onTranscriptScroll({ currentTarget: returned.node });
returned.unmount();
const sibling = mount("other");
assert.equal(sibling.node.scrollTop, 800);
sibling.unmount();
const expanded = mount("one", ["earlier", "first"], 1400);
assert.equal(
  expanded.node.scrollTop,
  700,
  "prepended history preserves the old reading location",
);
expanded.hook.scrollTranscriptToBottom();
assert.equal(expanded.node.scrollTop, 1200);
expanded.unmount();
const following = mount("one", ["earlier", "first", "new"], 1800);
assert.equal(
  following.node.scrollTop,
  1600,
  "explicit latest resumes following after remount",
);
following.unmount();
for (const input of ["wheel", "touch", "keyboard", "pointer"]) {
  const reader = mount(`small-${input}`);
  if (input === "wheel") reader.hook.onTranscriptWheel({ deltaY: -10 });
  if (input === "touch") {
    reader.hook.onTranscriptTouchStart({ touches: [{ clientY: 100 }] });
    reader.hook.onTranscriptTouchMove({ touches: [{ clientY: 110 }] });
  }
  if (input === "keyboard") reader.hook.onTranscriptKeyDown({ key: "ArrowUp" });
  if (input === "pointer") reader.hook.onTranscriptPointerDown();
  else {
    // A pending activity frame can run before the browser applies the gesture.
    reader.activityUpdate();
  }
  reader.node.scrollTop -= 10;
  reader.hook.onTranscriptScroll({ currentTarget: reader.node });
  reader.activityUpdate();
  assert.equal(
    reader.node.scrollTop,
    790,
    `${input}: activity must not snap a small upward gesture back to latest`,
  );
  reader.node.scrollHeight += 20;
  reader.activityUpdate();
  assert.equal(
    reader.node.scrollTop,
    790,
    `${input}: streaming preserves position`,
  );
  reader.node.scrollTop = 820;
  reader.hook.onTranscriptScroll({ currentTarget: reader.node });
  reader.node.scrollHeight += 100;
  reader.activityUpdate();
  assert.equal(
    reader.node.scrollTop,
    920,
    `${input}: scrolling down resumes following`,
  );
  reader.unmount();
}
const smallReader = mount("small-remount");
smallReader.hook.onTranscriptWheel({ deltaY: -10 });
smallReader.node.scrollTop = 790;
smallReader.hook.onTranscriptScroll({ currentTarget: smallReader.node });
smallReader.unmount();
const smallRestored = mount("small-remount");
assert.equal(
  smallRestored.node.scrollTop,
  790,
  "near-bottom reading survives remount",
);
smallRestored.node.scrollHeight += 20;
smallRestored.activityUpdate();
assert.equal(
  smallRestored.node.scrollTop,
  790,
  "restoration does not resume following",
);
smallRestored.unmount();
console.log(
  "Chat scroll: small wheel/touch/key/pointer gestures, activity updates, remount, reader/following state, older-page geometry, sibling isolation and bounded memory passed.",
);
