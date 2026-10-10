import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const createFeedback = vm.runInNewContext(
  readFileSync(
    new URL(
      "../apps/desktop/src-tauri/src/browser_pointer_feedback.js",
      import.meta.url,
    ),
    "utf8",
  ),
);
function fixture(reduced = false) {
  const timers = new Map();
  let timerId = 0;
  const animations = [];
  class Element {
    children = [];
    attributes = {};
    style = {};
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
    }
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
    }
    get firstChild() {
      return this.children[0];
    }
    get lastChild() {
      return this.children.at(-1);
    }
    get offsetWidth() {
      return (this.textContent?.length ?? 0) * 7 + 12;
    }
    animate(...args) {
      animations.push(args);
    }
  }
  const root = new Element();
  const document = {
    documentElement: root,
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  };
  const window = {
    innerWidth: 720,
    innerHeight: 480,
    matchMedia: () => ({ matches: reduced }),
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const target = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 80,
      width: 100,
      height: 40,
    }),
  };
  return {
    feedback: createFeedback(window, document),
    root,
    window,
    target,
    timers,
    animations,
  };
}

const f = fixture();
f.feedback.show(f.target, {
  x: 120,
  y: 90,
  phase: "move",
  action: "click",
  actor: "Codex",
});
assert.equal(f.root.children.length, 1, "movement paints only the AI cursor");
const pointer = f.root.firstChild;
assert.equal(
  pointer.style.left,
  "118px",
  "arrow tip must be at the actual click coordinate",
);
assert.equal(pointer.style.top, "88px");
assert.equal(pointer.lastChild.textContent, "Codex");
assert.match(pointer.style.cssText, /pointer-events:none/);
assert.equal(pointer.attributes["aria-hidden"], "true");
f.feedback.show(f.target, { x: 120, y: 90, action: "click", actor: "Codex" });
assert.equal(
  f.root.firstChild,
  pointer,
  "subsequent actions reuse the visible cursor",
);
assert.equal(f.root.children.length, 2, "click also highlights its target");
assert.equal(
  f.animations.length,
  1,
  "a press pulse distinguishes clicks from movement",
);
f.feedback.setHidden(true);
assert.ok(f.root.children.every((el) => el.style.visibility === "hidden"));
f.feedback.setHidden(false);
assert.ok(f.root.children.every((el) => el.style.visibility === "visible"));
for (const [id, timer] of [...f.timers])
  if (timer.ms === 700) {
    f.timers.delete(id);
    timer.fn();
  }
assert.equal(
  f.root.children.length,
  1,
  "target highlight clears while the cursor remains",
);
assert.equal(
  [...f.timers.values()][0].ms,
  6000,
  "pointer remains visible with the presence strip",
);
f.feedback.show(f.target, {
  action: "drag",
  x: 120,
  y: 90,
  toX: 719,
  toY: 479,
});
assert.equal(
  pointer.style.left,
  "717px",
  "drag feedback ends at the destination",
);
assert.equal(pointer.lastChild.style.top, "-24px");
assert.ok(
  Number.parseFloat(pointer.lastChild.style.left) < 0,
  "only the label flips at the edge",
);
f.feedback.clear();
assert.equal(f.root.children.length, 0);
assert.equal(f.timers.size, 0);
const reduced = fixture(true);
reduced.feedback.show(reduced.target, { action: "click" });
assert.equal(reduced.root.firstChild.style.transition, "none");
assert.equal(reduced.animations.length, 0);
assert.equal(reduced.root.firstChild.lastChild.textContent, "Gyro");
reduced.feedback.show(reduced.target, { x: NaN, y: 20 });
assert.equal(
  reduced.root.children.length,
  2,
  "invalid feedback must not replace the last valid pointer",
);
console.log(
  "browser pointer: click location, persistence, capture hide/restore, drag, cleanup and reduced motion passed",
);
