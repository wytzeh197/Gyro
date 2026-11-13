#!/usr/bin/env node
// Real React capture fixtures; no native session or provider calls.
// Start the desktop Vite server, then run: node scripts/check-theme-parity-browser.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname))
  throw new Error("Theme fixtures must run on loopback.");
const executable = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
].find((path) => path && existsSync(path));
if (!executable) throw new Error("Set GYRO_CAPTURE_BROWSER to a Chromium executable.");
const profile = mkdtempSync(resolve(tmpdir(), "gyro-theme-parity-"));
const output = resolve("artifacts/screenshots/theme-parity");
mkdirSync(output, { recursive: true });
const browser = spawn(executable, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-color-profile=srgb", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i++) {
    try { const result = await check(); if (result) return result; } catch {}
    await pause(200);
  }
  throw new Error(`Timed out: ${label}`);
};
let socket;
const results = [];
const failures = [];
try {
  const { readFileSync } = await import("node:fs");
  const port = await waitFor(() => {
    const path = resolve(profile, "DevToolsActivePort");
    return existsSync(path) && Number(readFileSync(path, "utf8").split("\n")[0]);
  }, "Chromium");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data)), p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(Error(method)); }, 15000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("DOM.enable");
  await call("CSS.enable");
  const cases = [];
  for (const theme of ["light", "dark"]) {
    for (const density of ["compact", "comfortable"])
      for (const size of ["small", "default", "large"])
        cases.push({ scene: "welcome", theme, density, size, width: 860, height: 620 });
    for (const scene of ["welcome", "active-chat", "appearance", "providers", "workspace-diff", "cli"])
      cases.push({ scene, theme, density: "compact", size: "default", width: 1440, height: 900 });
  }
  for (const state of cases) {
    const name = [state.scene, state.theme, state.width, state.density, state.size].join("-");
    await call("Emulation.setDeviceMetricsOverride", {
      width: state.width, height: state.height, deviceScaleFactor: 1, mobile: false,
    });
    const query = new URLSearchParams({ ...state, reset: "1", tour: "skip", motion: "reduced", accent: state.size === "large" ? "b24a84" : "0874df" });
    await call("Page.navigate", { url: `${origin}/capture.html?${query}` });
    await waitFor(() => evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(state.theme)} && !!document.querySelector(".gyro-app-shell") && !document.querySelector(".gyro-early-shell")`), name);
    await evaluate("document.fonts.ready.then(() => true)");
    await pause(350);
    const click = async (label) => {
      await waitFor(() => evaluate(`(() => {
        const label = ${JSON.stringify(label)};
        const buttons = [...document.querySelectorAll('button,[role="tab"]')].filter(n=>n.getBoundingClientRect().width);
        const match = buttons.find(n=>[n.textContent.trim(),n.getAttribute("aria-label"),n.title].some(v=>v===label))
          ?? buttons.find(n=>[n.textContent.trim(),n.getAttribute("aria-label"),n.title].some(v=>v?.startsWith(label)));
        if (!match) return false; match.click(); return true;
      })()`), "control: " + label);
      await pause(200);
    };
    if (state.scene === "active-chat") {
      await click("Bound the sync");
      await waitFor(() => evaluate('!!document.querySelector(".gyro-chat-turn")'), "chat thread");
    }
    if (["appearance", "providers"].includes(state.scene)) {
      await click("Settings");
      await click(state.scene === "appearance" ? "Appearance" : "Models & accounts");
      await waitFor(() => evaluate('!!document.querySelector(".gyro-settings-surface")'), "settings");
    }
    if (["workspace-diff", "cli"].includes(state.scene)) {
      await click("Workspace");
      if (state.scene === "cli") {
        await click("Open the workspace panel");
      } else {
        await click("Source Control");
        await click("Open diff for src/sync.js");
        await waitFor(() => evaluate('!!document.querySelector(".monaco-diff-editor .view-lines")'), "rendered diff");
      }
      await waitFor(() => evaluate(`!!document.querySelector("${state.scene === "cli" ? ".gyro-terminal-workspace" : ".gyro-workspace-route"}")`), "workspace");
    }
    // Normalize every supported CSS color through canvas, including color-mix.
    await evaluate(`window.themeProbe = (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.getBoundingClientRect().width) return null;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      const ctx = document.createElement("canvas").getContext("2d");
      const rgba = (color) => { ctx.clearRect(0,0,1,1); ctx.fillStyle=color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v); };
      const over = (a,b) => [0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
      const chain=[]; for(let n=el;n;n=n.parentElement) chain.unshift(n);
      let bg=[255,255,255,1]; for(const n of chain) bg=over(rgba(getComputedStyle(n).backgroundColor),bg);
      const ink=over(rgba(style.color),bg);
      const lum=(c)=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
      const a=lum(ink),b=lum(bg),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      return { color:style.color,background:style.backgroundColor,contrast,outline:style.outlineStyle,outlineWidth:style.outlineWidth,
        visible:rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight,
        width:rect.width,height:rect.height,text:el.textContent.trim().slice(0,80) };
    }`);
    const checks = [];
    const probe = async (selector, label) => {
      const value = await evaluate(`window.themeProbe(${JSON.stringify(selector)})`);
      checks.push({ label, ...value });
      if (!value || value.contrast < 4.5 || !value.visible) failures.push({ name, label, value });
      return value;
    };
    if (state.scene === "welcome") {
      const selector = ".gyro-context-summary-item.is-workspace-mode";
      await probe(selector, "workspace mode resting");
      const { root } = await call("DOM.getDocument");
      const { nodeId } = await call("DOM.querySelector", { nodeId: root.nodeId, selector });
      await call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      await pause(200);
      await probe(selector, "workspace mode hover");
      await call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      const focused = await probe(selector, "workspace mode keyboard focus");
      if (focused?.outline === "none" || parseFloat(focused?.outlineWidth ?? "0") < 1)
        failures.push({ name, label: "missing keyboard focus", value: focused });
      await call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await pause(150);
      await probe(selector, "workspace mode expanded");
      await probe(".gyro-workspace-mode-picker .gyro-composer-menu-item", "workspace menu");
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      if (await evaluate('!!document.querySelector(".gyro-workspace-mode-picker")'))
        failures.push({ name, label: "Escape did not dismiss menu" });
      // Keep the screenshot on the exact hover state reported by the user.
      await call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    }
    if (state.scene === "active-chat")
      await probe(".gyro-response-body", "response text");
    if (state.scene === "cli")
      await probe(".gyro-terminal-workspace", "terminal text");
    if (["appearance", "providers"].includes(state.scene))
      await probe(".gyro-settings-surface h1", "settings heading");
    if (state.scene === "appearance") {
      await probe(".gyro-appearance-scope > span", "appearance scope");
      await click("System theme");
      for (const mode of ["dark", "light"]) {
        await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });
        await waitFor(() => evaluate(`document.documentElement.dataset.theme === "${mode}" && getComputedStyle(document.documentElement).colorScheme === "${mode}"`), "system " + mode);
      }
      await click(state.theme === "light" ? "Light theme" : "Dark theme");
      await waitFor(() => evaluate(`document.documentElement.dataset.theme === "${state.theme}"`), "explicit theme");
    }
    const summary = await evaluate(`({
      theme: document.documentElement.dataset.theme,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      overflow: document.documentElement.scrollWidth > innerWidth,
      headings: [...document.querySelectorAll("h1,h2")].map(n=>n.textContent).slice(0,4)
    })`);
    if (summary.scheme !== state.theme || summary.overflow) failures.push({ name, summary });
    if (state.width === 1440) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(resolve(output, name + ".png"), Buffer.from(shot.data, "base64"));
    }
    results.push({ name, ...summary, checks });
    console.log(name + ": " + (failures.some(f=>f.name===name) ? "FAIL" : "ok"));
  }
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ results, failures }, null, 2) + "\n");
  console.log(`${results.length} theme cases, ${failures.length} failures; screenshots: ${output}`);
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await Promise.race([new Promise(done => browser.once("exit", done)), pause(2000)]);
  if (browser.exitCode !== null || browser.signalCode !== null) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
