#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const releaseSource = read("site/release-utils.js").replace(/^export /gm, "");
const appSource = read("site/app.js").replace(/^import \{[\s\S]*?\} from "[^"]+";\s*/, "");
const fixture = JSON.parse(read("site/fixtures/latest-release.json"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function element() {
  const listeners = new Map();
  return {
    dataset: {},
    textContent: "",
    hidden: false,
    disabled: false,
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    setAttribute(name, value) { this[name] = value; },
  };
}

function utilityContext(overrides = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const context = createContext({
    URL,
    AbortController,
    window: {
      setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout(id) { timers.delete(id); },
    },
    ...overrides,
  });
  runInContext(releaseSource, context);
  return { context, timers };
}

const { context: utils } = utilityContext();
assert.equal(utils.isUsableRelease(fixture), true);
assert.equal(utils.isUsableRelease({ ...fixture, draft: true }), false);
assert.equal(utils.isUsableRelease({ ...fixture, tag_name: " " }), false);
for (const url of [
  "javascript:alert(1)",
  "data:text/html,unsafe",
  "http://github.com/wytzeh197/Gyro/releases/tag/v1",
  "https://github.com.evil.invalid/wytzeh197/Gyro/releases/tag/v1",
  "https://github.com/another/project/releases/tag/v1",
  "https://evil.invalid/",
  "https://user:secret@github.com/wytzeh197/Gyro/releases/tag/v1",
  "https://github.com/wytzeh197/Gyro/releases/tag/v1?redirect=elsewhere",
]) {
  assert.equal(utils.isUsableRelease({ ...fixture, html_url: url }), false, url);
  const assets = utils.selectReleaseAssets({
    assets: [{ ...fixture.assets[0], browser_download_url: url }],
  });
  assert.equal(assets.appleSilicon, undefined, url);
}
const malformedAssets = utils.selectReleaseAssets({
  assets: [null, 1, {}, { name: 42 }, { name: {} }, ...fixture.assets],
});
assert.equal(malformedAssets.appleSilicon.name, fixture.assets[0].name);
assert.equal(malformedAssets.intel.name, fixture.assets[1].name);
assert.equal(malformedAssets.checksums.name, "SHA256SUMS");

{
  let options;
  const { context, timers } = utilityContext({
    fetch: async (_url, requestOptions) => {
      options = requestOptions;
      return { ok: true, json: async () => fixture };
    },
  });
  assert.equal(await context.fetchGitHubJson("https://api.github.com/"), fixture);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(timers.size, 0, "Successful requests must release deadline timers");
}
for (const response of [
  { ok: false, status: 503 },
  { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } },
]) {
  const { context, timers } = utilityContext({ fetch: async () => response });
  await assert.rejects(context.fetchGitHubJson("https://api.github.com/"));
  assert.equal(timers.size, 0, "Failed requests must release deadline timers");
}
{
  const { context, timers } = utilityContext({
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")));
    }),
  });
  const request = context.fetchGitHubJson("https://api.github.com/");
  const rejected = assert.rejects(request, /Aborted/);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  await rejected;
  assert.equal(timers.size, 0, "Timed-out requests must release deadline timers");
}

function downloadPage(release = fixture) {
  const inputs = ["apple-silicon", "intel"].map((value, index) => ({
    ...element(), value, checked: index === 0,
  }));
  const roles = new Map();
  const surface = {
    querySelector(selector) {
      const role = selector.match(/^\[data-role="([^"]+)"\]$/)?.[1];
      if (role) {
        if (!roles.has(role)) roles.set(role, element());
        return roles.get(role);
      }
      if (selector.includes(":checked")) return inputs.find((input) => input.checked);
      const value = selector.match(/^input\[value="([^"]+)"\]$/)?.[1];
      return inputs.find((input) => input.value === value);
    },
    querySelectorAll() { return inputs; },
  };
  // Match the browser's native radio group behavior for programmatic checks.
  let selected = "apple-silicon";
  for (const input of inputs) {
    Object.defineProperty(input, "checked", {
      get() { return selected === input.value; },
      set(checked) { if (checked) selected = input.value; },
    });
  }
  let resolveHints;
  let fetchCalls = 0;
  const { context } = utilityContext({
    document: {
      querySelectorAll(selector) {
        return selector === "[data-download-surface]" ? [surface] : [];
      },
      querySelector() { return null; },
    },
    navigator: {
      userAgentData: {
        getHighEntropyValues: () => new Promise((resolve) => { resolveHints = resolve; }),
      },
    },
    fetch: async () => {
      fetchCalls++;
      return { ok: true, json: async () => release };
    },
  });
  runInContext(appSource, context);
  return {
    roles,
    inputs,
    surface,
    fetchCalls,
    resolveHints(hints) { resolveHints(hints); },
    select(value) {
      const input = inputs.find((item) => item.value === value);
      input.checked = true;
      input.dispatch("change");
    },
  };
}

{
  const page = downloadPage();
  assert.equal(page.fetchCalls, 1, "Pending architecture hints must not delay release fetch");
  await tick();
  assert.equal(page.roles.get("download-link").href, fixture.assets[0].browser_download_url);
  page.select("intel");
  page.resolveHints({ platform: "macOS", architecture: "arm" });
  await tick();
  assert.equal(page.inputs[1].checked, true, "Late hints must respect manual choices");
  assert.equal(page.roles.get("download-link").href, fixture.assets[1].browser_download_url);
}
{
  const page = downloadPage();
  await tick();
  page.resolveHints({ platform: "macOS", architecture: "x86" });
  await tick();
  assert.equal(page.inputs[1].checked, true);
  assert.equal(page.roles.get("download-link").href, fixture.assets[1].browser_download_url,
    "A late hint must update both the radio and the download URL");
}
{
  const page = downloadPage({ ...fixture, assets: [fixture.assets[0]] });
  await tick();
  assert.equal(page.roles.get("copy-checksum").dataset.hash, "a".repeat(64));
  page.select("intel");
  assert.equal(page.roles.get("copy-checksum").disabled, true);
  assert.equal(page.roles.get("copy-checksum").dataset.hash, "",
    "A missing architecture must not retain the previous build's checksum");
}
{
  const page = downloadPage({ ...fixture, html_url: "javascript:alert(1)" });
  await tick();
  assert.equal(page.roles.get("release-fallback").hidden, false);
  assert.equal(page.roles.get("download-link").href,
    "https://github.com/wytzeh197/Gyro/releases/latest");
}

function pointerPage(enabled) {
  const canvas = element();
  canvas.width = 300;
  canvas.height = 150;
  canvas.getContext = () => ({ setTransform() {}, clearRect() {} });
  const media = { ...element(), matches: enabled };
  const document = {
    ...element(),
    readyState: "complete",
    hidden: false,
    documentElement: element(),
    body: { prepend() {} },
    createElement: () => canvas,
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const frames = new Map();
  let nextFrame = 0;
  runInContext(read("site/theme.js"), createContext({
    document,
    localStorage: { getItem() { return null; } },
    matchMedia: () => media,
    window: element(),
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { observe() {} },
  }));
  return { canvas, media, document, frames };
}

{
  const { canvas, media, document, frames } = pointerPage(false);
  assert.equal(canvas.width * canvas.height, 0,
    "Touch and reduced-motion pages must not allocate a viewport canvas");
  assert.equal(frames.size, 0);
  media.matches = true;
  media.dispatch("change");
  assert.equal(canvas.width, 2560);
  assert.equal(canvas.height, 1600);
  assert.equal(frames.size, 1);
  document.hidden = true;
  document.dispatch("visibilitychange");
  assert.equal(canvas.width * canvas.height, 0,
    "Background pages must release the decorative canvas buffer");
  assert.equal(frames.size, 0);
  document.hidden = false;
  document.dispatch("visibilitychange");
  assert.equal(canvas.width, 2560, "Returning to a visible page must restore the effect");
}

console.log("Download site runtime checks passed.");
