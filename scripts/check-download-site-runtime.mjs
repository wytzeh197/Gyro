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
    dispatch(type, event = {}) { listeners.get(type)?.call(this, event); },
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

function downloadPage(release = fixture, readyLabel) {
  const inputs = ["apple-silicon", "intel"].map((value, index) => ({
    ...element(), value, checked: index === 0,
  }));
  const roles = new Map();
  const surface = {
    dataset: { readyLabel },
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

{
  const page = downloadPage(fixture, "Download for macOS");
  await tick();
  assert.equal(page.roles.get("download-label").textContent, "Download for macOS");
  page.select("intel");
  assert.equal(page.roles.get("download-link").href, fixture.assets[1].browser_download_url);
}
{
  const page = downloadPage(null);
  await tick();
  assert.equal(page.roles.get("download-label").textContent, "Open GitHub Releases");
  assert.equal(page.roles.get("release-fallback").hidden, false);
}
// Theme remains a prepaint contract on all routes, including blocked storage.
function themePage(saved = null, blocked = false) {
  const toggle = element();
  const meta = element();
  const root = element();
  const storage = { value: saved,
    getItem() { if (blocked) throw new Error("Blocked"); return this.value; },
    setItem(key, value) { assert.equal(key, "gyro.site-theme"); if (blocked) throw new Error("Blocked"); this.value = value; },
  };
  const menu = { ...element(), open: true };
  const summary = { focused: false, focus() { this.focused = true; } };
  menu.querySelector = () => summary;
  runInContext(read("site/theme.js"), createContext({
    document: { readyState: "complete", documentElement: root,
      querySelector(selector) { return selector.startsWith("meta") ? meta : null; },
      querySelectorAll(selector) { return selector === "[data-theme-toggle]" ? [toggle] : [menu]; },
      createElement() { throw new Error("Theme must not allocate a pointer canvas"); },
    }, localStorage: storage,
  }));
  return { toggle, meta, root, storage, menu, summary };
}
for (const saved of [null, "light", "invalid", "dark"]) {
  const page = themePage(saved);
  assert.equal(page.root.dataset.theme, saved === "dark" ? undefined : "light");
  page.toggle.dispatch("click");
  assert.equal(page.storage.value, saved === "dark" ? "light" : "dark");
  assert.equal(page.toggle["aria-label"], saved === "dark" ? "Switch to dark theme" : "Switch to light theme");
  const next = themePage(page.storage.value);
  assert.equal(next.root.dataset.theme, saved === "dark" ? "light" : undefined,
    "The explicit choice must carry to the next page");
}
{
  const page = themePage(null, true);
  assert.equal(page.root.dataset.theme, "light");
  page.toggle.dispatch("click");
  assert.equal(page.root.dataset.theme, undefined);
  assert.equal(page.meta.content, "#0c0c0c");
  page.menu.dispatch("keydown", { key: "Escape" });
  assert.equal(page.menu.open, false);
  assert.equal(page.summary.focused, true);
  page.menu.open = true;
  page.menu.dispatch("click", { target: { closest: () => ({}) } });
  assert.equal(page.menu.open, false);
}

function classes(initial = []) {
  const set = new Set(initial);
  return { contains: (name) => set.has(name), add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    toggle(name, on) { if (on) set.add(name); else set.delete(name); },
  };
}
function agentPage({ reducedMotion = false, optionalObserver = true } = {}) {
  const names = ["Claude Code", "Codex", "Gemini CLI", "Grok Build", "Kimi Code", "Cursor", "OpenCode", "Ollama", "OpenRouter", "DeepSeek", "Mistral"];
  const words = names.map((name, index) => ({ ...element(), textContent: name,
    offsetWidth: name.length * 24, classList: classes(index === 3 ? ["is-on"] : []) }));
  const footprint = { style: {} };
  const slot = { style: {}, querySelectorAll: () => words, closest: () => footprint };
  const picks = names.map((name, index) => ({ ...element(), textContent: name,
    disabled: true, offsetWidth: 56, classList: classes(index === 3 ? ["is-on"] : []) }));
  const roster = element();
  const toggle = element();
  const selected = { textContent: "Grok Build" };
  const bounds = { top: 0, bottom: 400 };
  const section = { ...element(), getBoundingClientRect: () => bounds, classList: classes(), contains: (target) => picks.includes(target) || target === toggle,
    querySelectorAll: () => picks,
    querySelector(selector) { return ({ "[data-agent-slot]": slot, ".agent-roster": roster,
      "[data-agent-toggle]": toggle, "[data-agent-selected]": selected })[selector]; },
  };
  const document = { ...element(), hidden: false, querySelector: () => section };
  const media = { ...element(), matches: reducedMotion };
  const lifecycle = element();
  let observerCallback;
  let observed = false;
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const context = { document, innerHeight: 900, matchMedia: () => media,
    getComputedStyle: () => ({ paddingLeft: "12px", paddingRight: "12px", borderLeftWidth: "1px", borderRightWidth: "1px" }),
    performance: { now: () => now },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: (type, callback) => lifecycle.addEventListener(type, callback),
  };
  if (optionalObserver) context.IntersectionObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() { observed = true; }
    disconnect() { observed = false; }
  };
  runInContext(read("site/agents.js"), createContext(context));
  return { words, picks, slot, footprint, section, document, media, roster, toggle, selected, lifecycle, timers, bounds,
    visible(value) { observerCallback?.([{ isIntersecting: value }]); },
    elapse(ms) { now += ms; },
    observed: () => observed,
    advance() { const [id, timer] = [...timers][0]; timers.delete(id); now += timer.delay; timer.callback(); },
  };
}
{
  const page = agentPage();
  assert.equal(page.timers.size, 0, "Offscreen rotation must be idle");
  page.visible(true);
  assert.equal([...page.timers.values()][0].delay, 4500);
  assert.equal(page.picks.every((pick) => !pick.disabled), true);
  const footprint = page.footprint.style.width;
  page.advance();
  assert.equal(page.selected.textContent, "Kimi Code");
  assert.equal(page.footprint.style.width, footprint, "Automatic names must not move adjacent wording");
  page.elapse(1500);
  page.roster.dispatch("pointerenter", { pointerType: "mouse" });
  assert.equal(page.timers.size, 0);
  page.roster.dispatch("pointerleave");
  assert.equal([...page.timers.values()][0].delay, 3000, "Hover resumes the remaining cycle");
  page.picks[1].dispatch("click");
  assert.equal(page.selected.textContent, "Codex");
  assert.equal(page.timers.size, 0, "Manual choice must persist");
  assert.equal(page.toggle.textContent, "Resume rotation");
  page.visible(false); page.visible(true);
  assert.equal(page.timers.size, 0, "Re-entering view must not undo manual pause");
  page.toggle.dispatch("click");
  assert.equal(page.timers.size, 1);
  page.section.dispatch("focusin");
  assert.equal(page.timers.size, 0, "Keyboard interaction pauses rotation");
  page.section.dispatch("focusout", { relatedTarget: page.picks[2] });
  assert.equal(page.timers.size, 0);
  page.section.dispatch("focusout", { relatedTarget: null });
  assert.equal(page.timers.size, 1);
  page.document.hidden = true; page.document.dispatch("visibilitychange");
  assert.equal(page.timers.size, 0);
  page.document.hidden = false; page.document.dispatch("visibilitychange");
  assert.equal(page.timers.size, 1);
  page.media.matches = true; page.media.dispatch("change");
  assert.equal(page.timers.size, 0, "Reduced motion releases the timer immediately");
  page.media.matches = false; page.media.dispatch("change");
  assert.equal(page.timers.size, 1);
  page.lifecycle.dispatch("pagehide");
  assert.equal(page.timers.size, 0, "Navigation must release timers");
  assert.equal(page.observed(), false);
  page.lifecycle.dispatch("pageshow");
  assert.equal(page.observed(), true);
  assert.equal(page.timers.size, 1, "Returning from the back-forward cache resumes safely");
}
{
  const page = agentPage({ reducedMotion: true });
  page.visible(true);
  assert.equal(page.timers.size, 0);
  page.picks[10].dispatch("click");
  assert.equal(page.selected.textContent, "Mistral");
  assert.equal(page.timers.size, 0, "Reduced motion keeps manual provider selection available");
}
{
  const page = agentPage({ optionalObserver: false });
  assert.equal(page.timers.size, 1, "Missing optional observer API must not break enhancement");
  page.bounds.top = 1200; page.bounds.bottom = 1600;
  page.lifecycle.dispatch("scroll");
  assert.equal(page.timers.size, 0, "Offscreen rotation also pauses without the optional observer");
  page.bounds.top = 0; page.bounds.bottom = 400;
  page.lifecycle.dispatch("scroll");
  assert.equal(page.timers.size, 1);
  page.picks[0].dispatch("click");
  assert.equal(page.selected.textContent, "Claude Code");
}

// Manual view controls retain focus and one stable, accessible selected panel.
{
  const cards = Array.from({ length: 3 }, () => ({ ...element(), id: "" }));
  const buttons = cards.map(() => element());
  const switcher = { ...element(), hidden: true, querySelectorAll: () => buttons };
  const product = { classList: classes() };
  const { context } = utilityContext({
    document: {
      querySelector(selector) { return selector === ".workspace-switcher" ? switcher : product; },
      querySelectorAll(selector) { return selector === ".spine > .surface-card" ? cards : []; },
    },
  });
  runInContext(appSource, context);
  assert.equal(switcher.hidden, false);
  assert.deepEqual(cards.map((card) => card.hidden), [false, true, true]);
  for (let index = 0; index < buttons.length; index++) {
    buttons[index].dispatch("click");
    assert.deepEqual(cards.map((card) => card.hidden), cards.map((_card, i) => i !== index));
    assert.equal(buttons[index]["aria-controls"], cards[index].id);
    assert.equal(buttons[index]["aria-pressed"], "true");
  }
}
console.log("Download site runtime checks passed (release, theme, navigation, providers, views).");
