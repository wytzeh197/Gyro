// Production plan subscription + Environment panel, with simulated native events.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(resolve("apps/desktop/package.json"));
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatEnvironmentPopover } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { useSessionContextEvents, useDerivedSessionContext } from "/src/use-session-context-events.ts";
window.__TAURI_INTERNALS__ = {};
const initial = {id:"seed",sessionId:"live-plan",kind:"plan-updated",createdAt:"2026-11-11T12:00:00Z",message:"",payload:{action:"replace",content:"# Plan",items:[{id:"one",title:"Implement change",status:"todo"},{id:"two",title:"Verify behavior",status:"todo"}]}};
function Fixture() {
 const state=useSessionContextEvents();
 React.useEffect(()=>{state.replace("live-plan",[initial]);window.staleRefresh=()=>state.replace("live-plan",[initial]);},[state.replace]);
 const [recent,setRecent]=React.useState([]);
 window.setRecent=setRecent;
 const {plan}=useDerivedSessionContext(state.eventsBySession,"live-plan",recent);
 window.savedPlan=plan;
 return React.createElement("div",{style:{width:320,margin:20}}, React.createElement(ChatEnvironmentPopover,{
 attachments:[],branchLabel:"test",branchItems:[],isRunning:true,workspacePath:"/fixture/Gyro",plan,
 onPlanItemStatusChange:()=>{},onOpenPlan:()=>{}
 }));
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));
`;
const profile = await mkdtemp(join(tmpdir(), "gyro-plan-live-"));
const server = await createServer({
  root: resolve("apps/desktop"),
  cacheDir: join(profile, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "live-plan-verification",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === "/__live_plan.tsx") return "\0live-plan.tsx";
      if (id === "@tauri-apps/api/event" && importer?.endsWith("use-session-context-events.ts"))
        return "\0plan-event-mock";
    },
    load(id) {
      if (id === "\0live-plan.tsx") return fixture;
      if (id === "\0plan-event-mock") return 'export async function listen(channel,callback){window.planEventChannel=channel;window.deliverPlan=payload=>callback({payload});return()=>{delete window.deliverPlan;};}';
    },
    configureServer(s) {
      s.middlewares.use("/__live_plan.html", async (req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await s.transformIndexHtml("/__live_plan.html",
          '<html data-theme="dark"><body style="background:#141414"><div id="root"></div><script type="module" src="/__live_plan.tsx"></script></body></html>'));
      });
    },
  }],
});
await server.listen();
const origin = "http://127.0.0.1:" + server.httpServer.address().port;
let browser, ws;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = spawn(process.env.GYRO_CAPTURE_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--use-mock-keychain", "--password-store=basic",
    "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", launchError;
  browser.on("error", error => { launchError = error; });
  browser.stderr.on("data", value => { stderr = (stderr + value).slice(-4000); });
  async function until(check, label) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      if (launchError) throw launchError;
      const result = await check();
      if (result) return result;
      await pause(100);
    }
    throw Error("Timed out: " + label);
  }
  const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], "browser start");
  const pages = await (await fetch("http://" + new URL(endpoint).host + "/json/list")).json();
  ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(method + " timeout")); }, 20000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 600, height: 660, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: origin + "/__live_plan.html" });
  const counter = () => evaluate('document.querySelector(".is-plan header small")?.textContent');
  await until(async () => await counter() === "0 / 2", "initial counter");
  assert.equal(await evaluate("window.planEventChannel"), "gyro://session-plan-updated");
  const statuses = () => evaluate('[...document.querySelectorAll(".gyro-environment-plan-steps li")].map(el=>el.className)');
  assert.deepEqual(await statuses(), ["is-todo", "is-todo"]);
  async function emit(id, status, n) {
    const event = { id: "progress-" + n, sessionId: "live-plan", turnId: "active-turn",
      kind: "plan-updated", createdAt: "2026-11-11T12:00:0" + n + "Z", message: "",
      payload: { action: "update-items", items: [{ id, status }] } };
    await evaluate("window.deliverPlan(" + JSON.stringify(event) + ")");
  }
  await emit("one", "in-progress", 1);
  await until(async () => (await statuses())[0] === "is-in-progress", "working mark");
  await emit("one", "complete", 2);
  await emit("two", "in-progress", 3);
  await until(async () => await counter() === "1 / 2", "live completed count");
  assert.deepEqual(await statuses(), ["is-complete", "is-in-progress"]);
  await evaluate("window.staleRefresh()");
  await pause(100);
  assert.equal(await counter(), "1 / 2");
  await emit("two", "blocked", 4);
  await until(async () => (await statuses())[1] === "is-blocked", "blocked mark");
  assert.equal(await counter(), "1 / 2");
  const output = resolve("artifacts/plan-live-progress");
  await mkdir(output, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
    await pause(100);
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, "live-plan-" + theme + ".png"), Buffer.from(screenshot.data, "base64"));
  }
  await emit("two", "complete", 5);
  await until(async () => await counter() === "2 / 2", "all done");
  assert.equal(await evaluate('document.querySelectorAll(".gyro-plan-step-status.is-in-progress").length'), 0);
  const nextTask = {id:"next-task",sessionId:"live-plan",turnId:"next-turn",kind:"user-message",
    createdAt:"2026-11-11T12:00:07Z",message:"Start another task",payload:{optimistic:true}};
  await evaluate("window.setRecent(" + JSON.stringify([nextTask]) + ")");
  await until(async () => !(await counter()), "first new send clears the plan section");
  assert.equal(await evaluate('document.querySelector(".gyro-environment-plan-steps")'), null);
  assert.equal(await evaluate("window.savedPlan.content"), "# Plan");
  await evaluate("window.staleRefresh()");
  await pause(100);
  assert.equal(await counter(), undefined);
  // Reproduce the reported unfinished final marker, then a settled response and
  // a new user task. The existing component must clear without remounting it.
  await emit("two", "in-progress", 6);
  const settled = {id:"settled",sessionId:"live-plan",turnId:"active-turn",kind:"assistant-message",
    createdAt:"2026-11-11T12:00:06.500Z",message:"Implemented",payload:{kind:"provider-response"}};
  await evaluate("window.setRecent(" + JSON.stringify([settled, nextTask]) + ")");
  await until(async () => !(await counter()), "settled partial plan clears");
  assert.equal(await evaluate("window.savedPlan.items[1].status"), "in-progress");
  const replacement = {id:"new-plan",sessionId:"live-plan",turnId:"next-turn",kind:"plan-updated",
    createdAt:"2026-11-11T12:00:08Z",message:"",payload:{action:"replace",content:"# Next plan",
      items:[{id:"new",title:"New task step",status:"todo"}]}};
  await evaluate("window.deliverPlan(" + JSON.stringify(replacement) + ")");
  await until(async () => await counter() === "0 / 1", "new task plan appears");
  console.log("Live plan browser checks passed: progress, blocked/completed marks, first-send clearing for completed and stale partial plans, saved document retention, stale refresh, and replacement plan. Simulated native events, production hook and panel.");
} finally {
  ws?.close();
  const stopped = browser && browser.exitCode === null && browser.signalCode === null
    ? new Promise(resolve => browser.once("exit", resolve)) : Promise.resolve();
  browser?.kill("SIGTERM");
  await Promise.race([stopped, pause(5000)]);
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
