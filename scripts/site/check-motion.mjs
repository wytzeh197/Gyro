import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const { JSDOM } = await import(process.env.GYRO_TEST_JSDOM || "jsdom");
const source = readFileSync(
  new URL("../../site/motion.js", import.meta.url),
  "utf8",
);
for (const preference of ["default", "reduced", "save-data"]) {
  const dom = new JSDOM(
    '<html data-theme="light"><body><div class="product-stage"><video class="workflow-film"></video><button class="motion-toggle" hidden></button></div></body></html>',
    { runScripts: "outside-only" },
  );
  const w = dom.window;
  let intersection,
    paused = true,
    plays = 0,
    hidden = false;
  const preferenceListeners = [];
  w.matchMedia = () => ({
    matches: preference === "reduced",
    addEventListener: (_, fn) => preferenceListeners.push(fn),
  });
  Object.defineProperty(w.navigator, "connection", {
    value: { saveData: preference === "save-data" },
  });
  Object.defineProperty(w.document, "hidden", { get: () => hidden });
  w.IntersectionObserver = class {
    constructor(fn) {
      intersection = fn;
    }
    observe() {}
  };
  const video = w.document.querySelector("video");
  const button = w.document.querySelector("button");
  Object.defineProperty(video, "paused", { get: () => paused });
  video.load = () => {};
  video.play = async () => {
    paused = false;
    plays++;
    video.dispatchEvent(new w.Event("playing"));
  };
  video.pause = () => {
    paused = true;
    video.dispatchEvent(new w.Event("pause"));
  };
  new vm.Script(source).runInContext(dom.getInternalVMContext());
  intersection([{ isIntersecting: true }]);
  assert.equal(plays, 0, "Media must be user-started");
  assert.equal(video.getAttribute("src"), null);
  button.click();
  await new Promise(setImmediate);
  assert.equal(plays, 1);
  assert.match(video.getAttribute("src"), /^\/assets\/motion\/workflow-light/);
  assert.equal(paused, false);
  intersection([{ isIntersecting: false }]);
  assert(paused, "Offscreen film must pause");
  intersection([{ isIntersecting: true }]);
  await new Promise(setImmediate);
  hidden = true;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  assert(paused, "Hidden page must pause");
  hidden = false;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await new Promise(setImmediate);
  video.dispatchEvent(new w.Event("error"));
  assert(!video.classList.contains("is-playing"), "Error must reveal poster");
  w.document.documentElement.removeAttribute("data-theme");
  await new Promise(setImmediate);
  assert.match(video.getAttribute("src"), /^\/assets\/motion\/workflow-dark/);
  preferenceListeners.forEach((fn) => fn());
  assert(paused, "Preference changes stop manual playback");
  dom.window.close();
  console.log("PASS motion: " + preference);
}
