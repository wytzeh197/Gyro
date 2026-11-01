import assert from "node:assert/strict";
import {
  isChatPointerDragActive,
  registerChatPointerDropTarget,
  startChatPointerDrag,
} from "../packages/ui/src/chat-pointer-drag.ts";
import {
  beginChatPaneDrag,
  currentChatDrag,
  endChatDrag,
} from "../packages/ui/src/chat-session-drag.ts";

class TrackedTarget extends EventTarget {
  listeners = new Map();
  captureListeners = new Map();
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    if (options === true || options?.capture) {
      if (!this.captureListeners.has(type))
        this.captureListeners.set(type, new Set());
      this.captureListeners.get(type).add(listener);
    }
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
    this.captureListeners.get(type)?.delete(listener);
  }
  count(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
  dispatchDescendantBlur(element) {
    // Element blur traverses capture without bubbling. A flat Node EventTarget
    // dispatch would incorrectly call the native window-only blur listener.
    const event = new Event("blur");
    Object.defineProperty(event, "target", { value: element });
    for (const listener of [...(this.captureListeners.get("blur") ?? [])])
      listener.call(this, event);
  }
}

class Surface extends TrackedTarget {
  constructor(doc, bounds) {
    super();
    this.ownerDocument = doc;
    this.isConnected = true;
    this.hidden = false;
    this.style = { display: "block", visibility: "visible" };
    this.bounds = bounds;
    this.capture = new Set();
    this.captureCalls = 0;
  }
  getClientRects() {
    return this.hidden ? [] : [this.bounds];
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.bounds;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement)
      if (current === this) return true;
    return false;
  }
  setPointerCapture(id) {
    this.capture.add(id);
    this.captureCalls += 1;
  }
  hasPointerCapture(id) {
    return this.capture.has(id);
  }
  releasePointerCapture(id) {
    this.capture.delete(id);
    this.dispatchEvent(pointer("lostpointercapture", 0, 0, { pointerId: id }));
  }
}

const win = new TrackedTarget();
const doc = new TrackedTarget();
const classes = new Set();
doc.defaultView = win;
doc.visibilityState = "visible";
doc.documentElement = {
  classList: {
    add: (value) => classes.add(value),
    remove: (value) => classes.delete(value),
  },
};
win.getComputedStyle = (element) => element.style;
globalThis.window = win;
globalThis.document = doc;
const observers = new Set();
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
};
const timers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback) => {
  const id = ++nextTimer;
  timers.set(id, callback);
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
const flushTimers = () => {
  const callbacks = [...timers.values()];
  timers.clear();
  callbacks.forEach((callback) => callback());
};
const pointer = (type, x, y, extra = {}) =>
  Object.assign(new Event(type, { cancelable: true }), {
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    detail: type === "click" ? 1 : 0,
    isPrimary: true,
    pointerId: 7,
    pointerType: "mouse",
    ...extra,
  });
const dispatch = (type, x = 0, y = 0, extra = {}) => {
  const event = pointer(type, x, y, extra);
  win.dispatchEvent(event);
  return event;
};
const payload = {
  kind: "session",
  sessionId: "alpha",
  projectKey: "/fixture/Gyro",
};
const source = new Surface(doc, { left: 0, top: 0, width: 80, height: 100 });
const left = new Surface(doc, { left: 100, top: 0, width: 100, height: 100 });
const right = new Surface(doc, { left: 200, top: 0, width: 100, height: 100 });
let hitOverride;
doc.elementFromPoint = (x, y) => {
  if (hitOverride !== undefined) return hitOverride;
  return (
    [right, left, source].find((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        element.isConnected &&
        !element.hidden &&
        element.style.display !== "none" &&
        element.style.visibility !== "hidden" &&
        x >= bounds.left &&
        x < bounds.right &&
        y >= bounds.top &&
        y < bounds.bottom
      );
    }) ?? null
  );
};
const log = [];
const target = (name, element) => ({
  element,
  hover: (drag, point) => log.push({ action: "hover", name, drag, point }),
  drop: (drag, point) => log.push({ action: "drop", name, drag, point }),
  leave: () => log.push({ action: "leave", name }),
});
const unregisterLeft = registerChatPointerDropTarget(target("left", left));
const unregisterRight = registerChatPointerDropTarget(target("right", right));
const press = (extra = {}, value = payload) =>
  startChatPointerDrag(pointer("pointerdown", 1, 1, extra), source, value);
const active = () => {
  press();
  dispatch("pointermove", 120, 50);
  assert.ok(isChatPointerDragActive());
  assert.equal(currentChatDrag().inputMode, "pointer");
  assert.ok(classes.has("gyro-chat-pointer-dragging"));
  assert.ok(source.hasPointerCapture(7));
};
const clean = () => {
  assert.equal(currentChatDrag(), undefined);
  assert.equal(isChatPointerDragActive(), false);
  assert.equal(classes.size, 0);
  assert.equal(source.capture.size, 0);
  assert.equal(observers.size, 0);
  assert.equal(win.count("pointermove"), 0);
  assert.equal(source.count("lostpointercapture"), 0);
};

for (const extra of [
  { button: 2 },
  { pointerType: "touch" },
  { pointerType: "pen" },
  { isPrimary: false },
]) {
  press(extra);
  dispatch("pointermove", 120, 50);
  clean();
}
source.isConnected = false;
press();
source.isConnected = true;
dispatch("pointermove", 120, 50);
clean();

// Starting ordinary native lifecycle first verifies listener order cannot
// cancel a later pointer identity when a browser emits stale native events.
beginChatPaneDrag({ paneId: "native" });
endChatDrag();
press();
dispatch("pointermove", 6, 1);
assert.equal(source.captureCalls, 0, "capture waits for the 6px threshold");
assert.equal(currentChatDrag(), undefined);
assert.equal(classes.size, 0);
assert.equal(dispatch("dragstart").defaultPrevented, true);
dispatch("pointerup", 6, 1);
assert.equal(
  dispatch("click", 6, 1).defaultPrevented,
  false,
  "plain clicks keep activation",
);
clean();

press();
dispatch("pointermove", 7, 1);
assert.equal(source.captureCalls, 1, "the exact threshold activates once");
dispatch("pointerup", 7, 1);
assert.equal(dispatch("click", 7, 1).defaultPrevented, true);
clean();
flushTimers();

log.length = 0;
press();
win.dispatchDescendantBlur(source);
assert.equal(
  win.count("pointermove"),
  1,
  "changing focused sidebar buttons preserves the pending gesture",
);
dispatch("pointermove", 120, 50);
const afterFocusDrag = currentChatDrag();
assert.equal(
  afterFocusDrag?.inputMode,
  "pointer",
  "a descendant blur before movement must not hand off to native dragging",
);
assert.equal(dispatch("dragstart").defaultPrevented, true);
win.dispatchDescendantBlur(right);
assert.equal(
  currentChatDrag(),
  afterFocusDrag,
  "descendant focus blur also preserves an active pointer gesture",
);
dispatch("pointerup", 220, 50);
assert.equal(log.filter(({ action }) => action === "drop").length, 1);
assert.equal(log.find(({ action }) => action === "drop").name, "right");
clean();
flushTimers();

press();
dispatch("blur");
dispatch("pointermove", 120, 50);
clean();

// WKWebView can report buttons:0 for a trusted held mouse move. The observed
// primary down/up and capture lifecycle define whether this gesture is held.
log.length = 0;
press({ buttons: 0 });
dispatch("pointermove", 120, 50, { buttons: 0 });
const zeroButtonsDrag = currentChatDrag();
assert.equal(
  zeroButtonsDrag?.inputMode,
  "pointer",
  "a held WebKit move with buttons:0 activates the pending gesture",
);
dispatch("pointermove", 220, 50, { buttons: 0 });
assert.equal(
  currentChatDrag(),
  zeroButtonsDrag,
  "held WebKit moves with buttons:0 preserve the active gesture",
);
dispatch("pointerup", 220, 50, { buttons: 0 });
assert.equal(log.filter(({ action }) => action === "drop").length, 1);
assert.equal(log.find(({ action }) => action === "drop").name, "right");
clean();
flushTimers();

log.length = 0;
press();
dispatch("pointerup", 220, 50);
assert.deepEqual(
  log.map(({ action, name }) => [action, name]),
  [
    ["hover", "right"],
    ["drop", "right"],
    ["leave", "right"],
  ],
  "a fast release can cross the threshold without an intervening move",
);
clean();
flushTimers();

log.length = 0;
active();
const identity = currentChatDrag();
assert.equal(dispatch("dragstart").defaultPrevented, true);
let nativeGridEvents = 0;
const nativeGridHandler = () => {
  nativeGridEvents += 1;
};
const nativeTypes = ["dragenter", "dragover", "drop", "dragend"];
for (const type of nativeTypes) win.addEventListener(type, nativeGridHandler);
for (const type of nativeTypes)
  assert.equal(
    dispatch(type, 120, 50, {
      dataTransfer: {
        types: ["application/x-gyro-chat-session"],
        getData: (type) =>
          type === "application/x-gyro-chat-session"
            ? JSON.stringify({
                sessionId: "stale",
                projectKey: payload.projectKey,
              })
            : "",
      },
    }).defaultPrevented,
    true,
    "stale native delivery is intercepted",
  );
for (const type of nativeTypes)
  win.removeEventListener(type, nativeGridHandler);
await Promise.resolve();
assert.equal(
  nativeGridEvents,
  0,
  "stale explicit native payloads never reach a grid",
);
assert.equal(
  currentChatDrag(),
  identity,
  "native events cannot end pointer identity",
);
dispatch("pointermove", 220, 50, { pointerId: 8 });
assert.equal(
  log.at(-1).name,
  "left",
  "another pointer cannot change this hover",
);
dispatch("pointerup", 220, 50, { pointerId: 8 });
assert.equal(currentChatDrag(), identity);
dispatch("pointermove", 350, 50);
assert.deepEqual(log.at(-1), { action: "leave", name: "left" });
dispatch("pointermove", 120, 50);
assert.equal(
  log.at(-1).action,
  "hover",
  "returning to the renderer resumes hover",
);
dispatch("pointerup", 220, 70);
assert.deepEqual(
  log.slice(-3).map(({ action, name }) => [action, name]),
  [
    ["hover", "right"],
    ["drop", "right"],
    ["leave", "right"],
  ],
);
assert.deepEqual(log.find(({ action }) => action === "drop").point, {
  x: 220,
  y: 70,
});
assert.equal(log.find(({ action }) => action === "drop").drag, identity);
dispatch("pointerup", 220, 70);
assert.equal(log.filter(({ action }) => action === "drop").length, 1);
assert.equal(dispatch("click", 220, 70, { detail: 0 }).defaultPrevented, false);
assert.equal(
  dispatch("click", 220, 70).defaultPrevented,
  true,
  "drag release cannot activate source",
);
clean();
flushTimers();

for (const hide of [
  () => {
    right.hidden = true;
  },
  () => {
    right.style.visibility = "hidden";
  },
  () => {
    right.style.display = "none";
  },
  () => {
    right.isConnected = false;
  },
]) {
  log.length = 0;
  active();
  hide();
  dispatch("pointerup", 220, 50);
  assert.equal(
    log.some(({ action }) => action === "drop"),
    false,
    "hidden grids never accept release",
  );
  right.hidden = false;
  right.style = { visibility: "visible", display: "block" };
  right.isConnected = true;
  clean();
  flushTimers();
}

log.length = 0;
active();
left.bounds.left = 400;
dispatch("pointerup", 120, 50);
assert.equal(
  log.some(({ action }) => action === "drop"),
  false,
  "release measures current geometry",
);
left.bounds.left = 100;
clean();
flushTimers();

// A covering command palette can appear after the last hover. Pointer capture
// must not let its release insert a chat into the grid behind the modal.
const modal = new Surface(doc, { left: 100, top: 0, width: 200, height: 100 });
const outsideSurface = new Surface(doc, {
  left: 0,
  top: 0,
  width: 300,
  height: 100,
});
for (const coveringHit of [modal, outsideSurface, null]) {
  log.length = 0;
  active();
  hitOverride = coveringHit;
  dispatch("pointerup", 120, 50);
  assert.deepEqual(log.at(-1), { action: "leave", name: "left" });
  assert.equal(
    log.some(({ action }) => action === "drop"),
    false,
    "release on a modal, outside surface, or missing painted hit rejects the covered grid",
  );
  hitOverride = undefined;
  clean();
  flushTimers();
}

// Environment/browser descendants inside the grid are legitimate targets even
// though they are not the registered grid node itself.
log.length = 0;
active();
const environment = new Surface(doc, {
  left: 200,
  top: 0,
  width: 100,
  height: 100,
});
environment.parentElement = right;
hitOverride = environment;
dispatch("pointerup", 220, 50);
assert.equal(log.filter(({ action }) => action === "drop").length, 1);
assert.equal(log.find(({ action }) => action === "drop").name, "right");
hitOverride = undefined;
clean();
flushTimers();

for (const cancel of [
  () => dispatch("keydown", 0, 0, { key: "Escape" }),
  () => dispatch("blur"),
  () => dispatch("pagehide"),
  () => {
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "visible";
  },
  () => dispatch("pointercancel"),
  () => source.dispatchEvent(pointer("lostpointercapture", 0, 0)),
  () => endChatDrag(),
  () => {
    source.isConnected = false;
    [...observers].forEach((observer) => observer.callback());
    source.isConnected = true;
  },
]) {
  log.length = 0;
  active();
  cancel();
  clean();
  assert.deepEqual(log.at(-1), { action: "leave", name: "left" });
  dispatch("pointerup", 220, 50);
  assert.equal(
    log.some(({ action }) => action === "drop"),
    false,
    "cancellation never commits a layout",
  );
  flushTimers();
  assert.equal(
    dispatch("click", 220, 50).defaultPrevented,
    false,
    "the click guard expires",
  );
}

// Starting a new native identity during a pointer gesture cancels only the
// pointer token, never the replacement started by the next interaction.
active();
const newer = beginChatPaneDrag({ paneId: "newer" });
assert.equal(currentChatDrag(), newer);
assert.equal(classes.size, 0);
assert.equal(source.capture.size, 0);
endChatDrag();
flushTimers();
clean();

active();
dispatch("keydown", 0, 0, { key: "Escape" });
dispatch("pointerdown", 1, 1);
assert.equal(
  dispatch("click", 1, 1).defaultPrevented,
  false,
  "a fresh press clears the old click guard",
);
flushTimers();
clean();

// Target unregistration removes its feedback immediately while allowing the
// current drag to continue into a different mounted grid.
log.length = 0;
active();
unregisterLeft();
assert.deepEqual(log.at(-1), { action: "leave", name: "left" });
dispatch("pointerup", 220, 50);
assert.equal(log.find(({ action }) => action === "drop").name, "right");
unregisterRight();
flushTimers();
clean();
assert.equal(timers.size, 0);
for (const type of ["pointerup", "pointercancel", "pointerdown", "click"])
  assert.equal(win.count(type), 0, `${type} temporary listeners are removed`);

console.log(
  "Chat pointer drag passed: threshold, clicks, capture, geometric release, hidden targets, native isolation, cancellation, and exactly-once drops.",
);
