import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const createFeedback = vm.runInNewContext(
  readFileSync(
    new URL("../apps/desktop/src-tauri/src/browser_pointer_feedback.js", import.meta.url),
    "utf8",
  ),
);
function fixture(reduced = false) {
  const timers = new Map();
  const frames = new Map();
  const listeners = new Map();
  const preferenceListeners = new Set();
  let timerId = 0;
  let frameId = 0;
  let now = 0;
  const animations = [];
  class Element {
    children = [];
    attributes = {};
    style = {};
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
    }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children.at(-1); }
    get offsetWidth() { return (this.textContent?.length ?? 0) * 7 + 12; }
    animate(keyframes, options) {
      const animation = {
        keyframes, options, cancelled: false,
        position: this.parent.style.transform,
        cancel() { this.cancelled = true; },
      };
      animations.push(animation);
      return animation;
    }
  }
  const root = new Element();
  const document = {
    documentElement: root,
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  };
  const preference = {
    matches: reduced,
    addEventListener(_name, fn) { preferenceListeners.add(fn); },
    removeEventListener(_name, fn) { preferenceListeners.delete(fn); },
  };
  const window = {
    innerWidth: 720, innerHeight: 480,
    performance: { now: () => now },
    matchMedia: () => preference,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const target = {
    getBoundingClientRect: () => ({ left: 100, top: 80, width: 100, height: 40 }),
  };
  return {
    feedback: createFeedback(window, document),
    root, window, target, timers, frames, animations, listeners, preferenceListeners,
    step(ms) {
      now += ms;
      for (const [id, fn] of [...frames]) {
        frames.delete(id);
        fn(now);
      }
    },
    reduce(value) {
      preference.matches = value;
      for (const fn of preferenceListeners) fn();
    },
  };
}
const tip = (pointer) => {
  const match = pointer.style.transform.match(/translate3d\(([-\d.e]+)px,([-\d.e]+)px,0\)/);
  assert.ok(match, "pointer uses compositor translation");
  return [Number(match[1]) + 2, Number(match[2]) + 2];
};
const at = (pointer, x, y) => {
  const [px, py] = tip(pointer);
  assert.ok(Math.abs(px - x) < 0.00001 && Math.abs(py - y) < 0.00001, `expected tip at ${x},${y}; got ${px},${py}`);
};
const showMove = (f, x, y, extra = {}) => f.feedback.show(f.target, {
  x, y, phase: "move", action: "hover", ...extra,
});

const f = fixture();
showMove(f, 120, 90, { actor: "Codex", action: "click" });
assert.equal(f.root.children.length, 1, "movement paints only the AI cursor");
const pointer = f.root.firstChild;
at(pointer, 120, 90);
assert.equal(f.frames.size, 0, "first appearance has no invented starting point");
assert.equal(pointer.lastChild.textContent, "Codex");
assert.match(pointer.style.cssText, /pointer-events:none/);
assert.equal(pointer.attributes["aria-hidden"], "true");
assert.equal(pointer.firstChild.style.transformOrigin, "2px 2px", "press pulse keeps the arrow tip anchored");

showMove(f, 600, 300);
at(pointer, 120, 90);
assert.equal(f.frames.size, 1);
const obsoleteFrame = [...f.frames.values()][0];
f.step(35);
const midway = tip(pointer);
assert.ok(midway[0] > 120 && midway[0] < 600, "movement progresses smoothly");
showMove(f, 80, 200);
at(pointer, ...midway);
const beforeStale = pointer.style.transform;
obsoleteFrame(1000);
assert.equal(pointer.style.transform, beforeStale, "interrupted frames cannot paint an old destination");
f.step(140);
at(pointer, 80, 200);
assert.equal(f.frames.size, 0, "quick movement finishes within 140ms");

showMove(f, 600, 400);
f.step(20);
f.feedback.show(f.target, { x: 120, y: 90, action: "click", actor: "Codex" });
assert.equal(f.root.firstChild, pointer, "actions reuse the visible cursor");
assert.equal(f.frames.size, 1, "completed clicks preserve smooth visual travel");
assert.equal(f.root.children.length, 2, "click highlights its target immediately");
assert.equal(f.animations.length, 0, "pulse waits for visual arrival, not native input");
f.step(25);
assert.notDeepEqual(tip(pointer), [120, 90], "consecutive clicks have an intermediate frame");
f.step(140);
at(pointer, 120, 90);
assert.equal(f.frames.size, 0);
assert.equal(f.animations.length, 1);
assert.equal(f.animations[0].position, pointer.style.transform, "press pulse starts at the completed click coordinate");
assert.ok([...f.timers.values()].every(({ ms }) => ms === 700 || ms === 6000), "feedback schedules no native input delay");

f.feedback.setHidden(true);
assert.ok(f.root.children.every((el) => el.style.visibility === "hidden"));
f.feedback.show(f.target, { x: 130, y: 90, action: "click" });
assert.ok(f.root.children.every((el) => el.style.visibility === "hidden"), "new feedback remains hidden during capture");
assert.equal(f.animations[0].cancelled, true, "new actions cancel previous pulses");
f.step(140);
const oldHighlightTimeout = [...f.timers.values()].find(({ ms }) => ms === 700).fn;
const oldLingerTimeout = [...f.timers.values()].find(({ ms }) => ms === 6000).fn;
f.feedback.setHidden(false);
assert.ok(f.root.children.every((el) => el.style.visibility === "visible"));

showMove(f, 500, 200);
assert.equal(f.animations[1].cancelled, true, "movement cancels a previous click pulse");
const hoverFrame = [...f.frames.keys()][0];
f.feedback.show(f.target, { x: 500, y: 200, action: "hover" });
assert.equal([...f.frames.keys()][0], hoverFrame, "hover completion does not restart movement");
oldHighlightTimeout();
oldLingerTimeout();
assert.equal(f.root.children.length, 1, "stale timers cannot clear newer feedback");
f.step(140);
at(pointer, 500, 200);

showMove(f, 120, 90, { action: "drag", toX: 719, toY: 479 });
assert.equal(f.frames.size, 1, "drag preparation targets the source");
f.feedback.show(f.target, { action: "drag", x: 120, y: 90, toX: 719, toY: 479 });
assert.equal(f.frames.size, 1, "completed native drag keeps visual travel independent of input");
f.step(140);
at(pointer, 719, 479);
assert.equal(f.frames.size, 0, "visual drag arrival settles within 140ms");
assert.equal(pointer.lastChild.style.top, "-24px");
assert.ok(Number.parseFloat(pointer.lastChild.style.left) < 0, "only the label flips at the edge");
for (const [id, timer] of [...f.timers]) {
  if (timer.ms === 700) { f.timers.delete(id); timer.fn(); }
}
assert.equal(f.root.children.length, 1, "target clears while cursor lingers");
assert.equal([...f.timers.values()][0].ms, 6000);

showMove(f, 150, 100);
const clearedFrame = [...f.frames.values()][0];
f.feedback.clear();
clearedFrame(2000);
assert.equal(f.root.children.length, 0);
assert.equal(f.timers.size, 0);
assert.equal(f.frames.size, 0);
assert.equal(f.listeners.size, 0);
assert.equal(f.preferenceListeners.size, 0, "cleanup releases motion listeners");
assert.ok(f.animations.every((animation) => animation.cancelled), "cleanup cancels every pulse");
f.feedback.setHidden(true);
showMove(f, 200, 100);
assert.equal(f.root.firstChild.style.visibility, "hidden", "hidden state survives recreation");
f.listeners.get("pagehide")();
assert.equal(f.root.children.length, 0, "pagehide cleans up feedback");

const reduced = fixture(true);
reduced.feedback.show(reduced.target, { action: "click" });
assert.equal(reduced.root.firstChild.style.transition, "none");
assert.equal(reduced.animations.length, 0);
assert.equal(reduced.root.firstChild.lastChild.textContent, "Gyro");
showMove(reduced, 600, 300);
at(reduced.root.firstChild, 600, 300);
assert.equal(reduced.frames.size, 0, "reduced motion moves immediately");
reduced.feedback.show(reduced.target, { x: NaN, y: 20 });
assert.equal(reduced.root.children.length, 1, "invalid feedback preserves the last valid pointer");

const dynamic = fixture();
showMove(dynamic, 10, 10);
showMove(dynamic, 600, 400);
dynamic.step(20);
dynamic.reduce(true);
at(dynamic.root.firstChild, 600, 400);
assert.equal(dynamic.frames.size, 0, "enabling reduced motion cancels active movement");
dynamic.reduce(false);
dynamic.feedback.show(dynamic.target, { action: "click" });
dynamic.step(140);
dynamic.reduce(true);
assert.equal(dynamic.animations[0].cancelled, true, "enabling reduced motion cancels active pulse");
dynamic.feedback.clear();

const fallback = fixture();
delete fallback.window.requestAnimationFrame;
showMove(fallback, 10, 10);
showMove(fallback, 600, 300);
at(fallback.root.firstChild, 600, 300);
assert.equal(fallback.frames.size, 0);
fallback.feedback.clear();
console.log("browser pointer: smooth interruption, synchronous click/drag ordering, hover, capture hiding, timer safety, cleanup and reduced motion passed");
