// Execute the production hook with a deterministic layout/animation clock.
// Native portal layout is reviewed separately in the guarded normal App.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  process.env.GYRO_COMPANION_MOTION_SOURCE ||
    new URL("../packages/ui/src/use-companion-motion.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
function harness({ connected = true, width = 570, reduced = false } = {}) {
  let cursor = 0;
  let dirty = false;
  let alive = true;
  let stateUpdatesAfterUnmount = 0;
  let now = 0;
  let next = 0;
  const slots = [];
  const effects = [];
  const timers = new Map();
  const frames = new Map();
  const listeners = new Set();
  const animations = [];
  const args = { open: true, width: `${width}px`, resizing: false };
  let exits = 0;
  let value;
  const onExit = () => exits++;
  const media = {
    matches: reduced,
    addEventListener: (_name, fn) => listeners.add(fn),
    removeEventListener: (_name, fn) => listeners.delete(fn),
  };
  const dock = {
    isConnected: connected,
    layoutWidth: width,
    contains: () => false,
    getBoundingClientRect() {
      return { width: this.layoutWidth };
    },
    animate(keyframes, options) {
      const animation = {
        keyframes,
        options,
        cancelled: false,
        cancel() {
          this.cancelled = true;
          this.oncancel?.();
        },
        finish() {
          this.onfinish?.();
        },
      };
      animations.push(animation);
      return animation;
    },
  };
  const ref = { current: dock };
  const React = {
    createContext: () => ({}),
    useCallback: (fn) => fn,
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (next) => {
          if (!alive) stateUpdatesAfterUnmount++;
          if (slots[index] !== next) {
            slots[index] = next;
            dirty = true;
          }
        },
      ];
    },
    useLayoutEffect(run, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: run() };
        });
      }
    },
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => {
      assert.equal(name, "react");
      return React;
    },
    document: { activeElement: null },
    HTMLElement: class {},
    getComputedStyle: () => ({ opacity: "1", getPropertyValue: () => "" }),
    window: {
      matchMedia: () => media,
      setTimeout(fn, delay) {
        const id = ++next;
        timers.set(id, { fn, at: now + delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    requestAnimationFrame(fn) {
      const id = ++next;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  function render(update = {}) {
    Object.assign(args, update);
    do {
      dirty = false;
      cursor = 0;
      value = exports.useCompanionMotion(
        ref,
        args.open,
        args.width,
        args.resizing,
        onExit,
      );
      effects.splice(0).forEach((run) => run());
    } while (dirty);
    return value;
  }
  return {
    dock,
    animations,
    render,
    get moving() {
      return render();
    },
    get exits() {
      return exits;
    },
    get stateUpdatesAfterUnmount() {
      return stateUpdatesAfterUnmount;
    },
    get pending() {
      return timers.size + frames.size;
    },
    frame() {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((fn) => fn(now));
      render();
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        render();
      }
      now = end;
    },
    reduce() {
      media.matches = true;
      [...listeners].forEach((fn) => fn());
      render();
    },
    unmount() {
      alive = false;
      slots.forEach((slot) => slot?.cleanup?.());
    },
  };
}
const results = [];
function check(name, run) {
  try {
    run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}
check(
  "ordinary opening reaches its measured width and releases the native host",
  () => {
    const h = harness();
    h.render();
    assert.equal(h.animations[0].keyframes[1].width, "570px");
    h.animations[0].finish();
    assert.equal(h.moving, false);
    assert.equal(h.pending, 0);
  },
);
for (const detached of [true, false]) {
  check(
    `${detached ? "detached portal" : "hidden rail"} measures after its parent reveals it`,
    () => {
      const h = harness({ connected: !detached, width: 0 });
      h.render();
      assert.equal(
        h.animations.length,
        0,
        "must not animate toward zero width",
      );
      h.dock.isConnected = true;
      h.dock.layoutWidth = 570;
      h.frame();
      assert.equal(h.animations[0].keyframes[1].width, "570px");
      h.animations[0].finish();
      assert.equal(h.moving, false);
    },
  );
}
check(
  "a portal that remains hidden does not retain a zero-width animation",
  () => {
    const h = harness({ width: 0 });
    h.render();
    h.frame();
    assert.equal(h.animations.length, 0);
    assert.equal(h.moving, false);
  },
);
check(
  "a missed animation completion releases the native host within 300ms",
  () => {
    const h = harness();
    h.render();
    h.advance(300);
    assert.equal(h.moving, false);
    assert.equal(h.animations[0].cancelled, true);
  },
);
check(
  "a stalled animation frame cannot hold the native host indefinitely",
  () => {
    const h = harness({ connected: false, width: 0 });
    h.render();
    h.advance(300);
    assert.equal(h.moving, false);
    assert.equal(h.pending, 0);
  },
);
check("external animation cancellation releases the native host", () => {
  const h = harness();
  h.render();
  h.animations[0].cancel();
  assert.equal(h.moving, false);
  assert.equal(h.pending, 0);
});
check(
  "a closing animation with no completion still removes the retained panel once",
  () => {
    const h = harness();
    h.render();
    h.animations[0].finish();
    h.render({ open: false });
    h.advance(300);
    assert.equal(h.exits, 1);
    h.advance(1000);
    assert.equal(h.exits, 1);
  },
);
check("unmount cancels pending work and ignores a queued completion", () => {
  const h = harness();
  h.render();
  const staleFinish = h.animations[0].onfinish;
  h.unmount();
  staleFinish();
  h.advance(1000);
  assert.equal(h.stateUpdatesAfterUnmount, 0);
  assert.equal(h.pending, 0);
});
check(
  "a resized animation ignores its predecessor's queued callback and deadline",
  () => {
    const h = harness();
    h.render();
    const staleFinish = h.animations[0].onfinish;
    h.advance(100);
    h.dock.layoutWidth = 620;
    h.render({ width: "620px" });
    staleFinish();
    h.advance(180);
    assert.equal(h.moving, true);
    h.advance(100);
    assert.equal(h.moving, false);
  },
);
check("reduced motion opens without an animation", () => {
  const h = harness({ reduced: true });
  h.render();
  assert.equal(h.moving, false);
  assert.equal(h.animations.length, 0);
});
check(
  "switching to reduced motion settles even while portal layout is pending",
  () => {
    const h = harness({ connected: false, width: 0 });
    h.render();
    h.reduce();
    assert.equal(h.moving, false);
    assert.equal(h.pending, 0);
  },
);
check(
  "active pointer resizing settles without adding another animation",
  () => {
    const h = harness();
    h.render({ resizing: true });
    assert.equal(h.moving, false);
    assert.equal(h.animations.length, 0);
  },
);
check("reopening before close completes does not run a stale exit", () => {
  const h = harness();
  h.render();
  h.animations[0].finish();
  h.render({ open: false });
  const staleFinish = h.animations.at(-1).onfinish;
  h.render({ open: true });
  staleFinish();
  h.animations.at(-1).finish();
  assert.equal(h.exits, 0);
  assert.equal(h.moving, false);
});
console.log(
  JSON.stringify(
    { passed: results.every((r) => r.passed), checks: results },
    null,
    2,
  ),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
