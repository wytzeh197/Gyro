import assert from "node:assert/strict";
import { observeBrowserHostBounds } from "../packages/ui/src/browser-host-bounds.ts";

const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
let visibility = "visible";
globalThis.getComputedStyle = () => ({ visibility });
let rect = { left: 20, top: 48, width: 400, height: 600 };
const element = { getBoundingClientRect: () => rect };
const reports = [];
const tick = () => {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback());
};
const stop = observeBrowserHostBounds(element, (bounds) =>
  reports.push(bounds),
);
assert.deepEqual(reports, [{ x: 20, y: 48, width: 400, height: 600 }]);
for (let frame = 0; frame < 10; frame++) tick();
assert.equal(reports.length, 1, "stationary hosts must not send redundant IPC");
rect = { ...rect, left: 450, top: 300 };
tick();
assert.deepEqual(
  reports.at(-1),
  { x: 450, y: 300, width: 400, height: 600 },
  "pane movement without resizing follows the host",
);
visibility = "hidden";
tick();
assert.equal(
  reports.at(-1),
  null,
  "maximized-away content must hide its native view",
);
visibility = "visible";
tick();
assert.notEqual(reports.at(-1), null);
rect = { ...rect, width: 0, height: 0 };
tick();
assert.equal(
  reports.at(-1),
  null,
  "display:none hosts must hide their native view",
);
rect = { ...rect, width: 400, height: 600 };
tick();
stop();
assert.equal(reports.at(-1), null, "unmount hides the native view");
assert.equal(frames.size, 0, "unmount cancels tracking");
console.log("browser host bounds: passed");
