import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createSurfaceTiming } from "../apps/desktop/src/surface-timing.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

function clockHarness() {
  let time = 10,
    id = 0,
    visible = true;
  const frames = new Map(),
    saved = [];
  return {
    frames,
    saved,
    now: () => time,
    at: (value) => {
      time = value;
    },
    visible: () => visible,
    show: (value) => {
      visible = value;
    },
    frame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame: (value) => frames.delete(value),
    save: (value) => saved.push(value),
    tick: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}
const make = (h) =>
  createSurfaceTiming({ ...h, firstCommit: { at: 10, surface: "chat" } });
const off = clockHarness(),
  disabled = make(off);
disabled.enable(false);
disabled.begin("chat", "settings");
disabled.commit("settings");
assert.equal(off.frames.size, 0);
assert.equal(off.saved.length, 0);
const h = clockHarness(),
  timing = make(h);
timing.enable(true);
timing.enable(true);
assert.equal(
  h.frames.size,
  1,
  "duplicate enable must not schedule duplicate work",
);
h.at(20);
h.tick();
h.at(40);
h.tick();
assert.deepEqual(h.saved[0], {
  kind: "startup",
  from: null,
  surface: "chat",
  startedToCommitMs: 10,
  startedToFrameOpportunityMs: 40,
});
h.at(100);
timing.begin("chat", "search");
timing.commit("chat");
assert.equal(
  h.frames.size,
  0,
  "old state during a transition is not its commit",
);
h.at(125);
timing.commit("search");
h.at(140);
h.tick();
h.at(155);
h.tick();
assert.deepEqual(h.saved[1], {
  kind: "navigation",
  from: "chat",
  surface: "search",
  startedToCommitMs: 25,
  startedToFrameOpportunityMs: 55,
});
h.at(200);
timing.begin("search", "settings");
timing.commit("settings");
h.tick();
timing.begin("settings", "chat");
timing.commit("chat");
h.tick();
h.tick();
assert.equal(h.saved.length, 3);
assert.equal(
  h.saved[2].surface,
  "chat",
  "superseded page must not claim a frame",
);
timing.begin("chat", "chat");
timing.commit("chat");
assert.equal(h.frames.size, 0);
h.show(false);
timing.begin("chat", "settings");
timing.commit("settings");
assert.equal(h.frames.size, 0);
h.show(true);
timing.begin("settings", "chat");
timing.commit("chat");
h.tick();
h.show(false);
h.tick();
assert.equal(h.saved.length, 3, "hidden between frames is unmeasured");
h.show(true);
for (let i = 0; i < 1000; i++) {
  timing.begin("chat", "settings");
  timing.commit("settings");
  assert.ok(h.frames.size <= 1);
}
timing.dispose();
assert.equal(h.frames.size, 0);
timing.enable(true);
timing.begin("settings", "chat");
timing.commit("chat");
assert.equal(h.frames.size, 0);
for (const sample of h.saved)
  assert.deepEqual(
    Object.keys(sample).sort(),
    [
      "from",
      "kind",
      "startedToCommitMs",
      "startedToFrameOpportunityMs",
      "surface",
    ].sort(),
  );

// Execute the real hook against the real reducer, including Strict Mode's
// setup/cleanup/setup cycle. UI persistence and transitions still use the same dispatch.
const hookSource = readFileSync(
  new URL("../apps/desktop/src/use-measured-workbench.ts", import.meta.url),
  "utf8",
);
const hookJs = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
async function hookHarness(enabled) {
  const c = clockHarness(),
    refs = [],
    layouts = [];
  let refIndex = 0,
    setup;
  let state = createInitialWorkbenchState();
  const commands = [],
    actions = [];
  const context = {
    exports: {},
    window: { __TAURI_INTERNALS__: {} },
    document: { visibilityState: "visible" },
    performance: { now: c.now },
    requestAnimationFrame: c.frame,
    cancelAnimationFrame: c.cancelFrame,
    console,
    Set,
    require: (name) => {
      if (name === "react")
        return {
          useRef: (value) => (refs[refIndex++] ??= { current: value }),
          useCallback: (callback) => callback,
          useReducer: () => [state, dispatch],
          useLayoutEffect: (callback) => layouts.push(callback),
          useEffect: (callback) => {
            setup = callback;
          },
        };
      if (name === "@gyro-dev/ui") return { workbenchReducer };
      if (name === "./surface-timing") return { createSurfaceTiming };
      if (name === "@tauri-apps/api/core")
        return {
          invoke: async (command, args) => {
            commands.push(command);
            if (command === "timing_diagnostics_enabled") return enabled;
            c.save(args.value);
          },
        };
      throw new Error("Unexpected timing hook dependency " + name);
    },
  };
  // WebKit browser methods require their Window receiver. A permissive fake
  // missed the original detached-method failure that native QA exposed.
  context.window.requestAnimationFrame = function (callback) {
    assert.equal(this, context.window, "frame method lost Window receiver");
    return c.frame(callback);
  };
  context.window.cancelAnimationFrame = function (id) {
    assert.equal(this, context.window, "cancel method lost Window receiver");
    return c.cancelFrame(id);
  };
  context.requestAnimationFrame = context.window.requestAnimationFrame;
  context.cancelAnimationFrame = context.window.cancelAnimationFrame;
  assert.throws(
    () =>
      createSurfaceTiming({
        ...c,
        frame: context.window.requestAnimationFrame,
        cancelFrame: context.window.cancelAnimationFrame,
        firstCommit: { at: 10, surface: "chat" },
      }).enable(true),
    /Window receiver/,
    "the original detached browser methods must reproduce the failure",
  );
  vm.runInNewContext(hookJs, context);
  const dispatch = (action) => {
    actions.push(action);
    state = workbenchReducer(state, action);
  };
  let measured;
  function render() {
    refIndex = 0;
    layouts.length = 0;
    const pair = context.exports.useMeasuredWorkbenchReducer(
      createInitialWorkbenchState,
    );
    assert.equal(pair[0], state);
    measured = pair[1];
    layouts.forEach((callback) => callback());
  }
  render();
  const firstCleanup = setup();
  firstCleanup();
  const cleanup = setup();
  await Promise.resolve();
  await Promise.resolve();
  return {
    c,
    commands,
    actions,
    render,
    cleanup,
    send: (action) => measured(action),
    surface: () => context.exports.timingSurface(state),
  };
}
const nativeOff = await hookHarness(false);
nativeOff.send({ type: "enter-workspace" });
nativeOff.render();
assert.equal(
  nativeOff.commands.filter((x) => x === "record_surface_timing").length,
  0,
);
assert.equal(nativeOff.actions.length, 1);
assert.equal(nativeOff.c.frames.size, 0);
nativeOff.cleanup();
const native = await hookHarness(true);
native.c.tick();
native.c.tick();
native.c.at(100);
native.send({ type: "enter-workspace" });
native.c.at(125);
native.render();
native.c.at(140);
native.c.tick();
native.c.at(155);
native.c.tick();
assert.equal(native.surface(), "explorer");
assert.equal(native.c.saved.at(-1).surface, "explorer");
assert.equal(native.c.saved.at(-1).startedToCommitMs, 25);
native.send({ type: "ide-select-view", view: "search" });
native.render();
native.c.tick();
native.c.tick();
assert.equal(native.c.saved.at(-1).surface, "search");
native.send({ type: "select-destination", destination: "settings" });
native.render();
native.c.tick();
native.c.tick();
assert.equal(native.c.saved.at(-1).surface, "settings");
assert.equal(
  native.actions.length,
  3,
  "each original action dispatches exactly once",
);
native.cleanup();
assert.equal(native.c.frames.size, 0);
console.log(
  "Surface timing: opt-out, actual reducer dispatch/commit, supersession, visibility, bounded frames and Strict Mode cleanup passed.",
);
