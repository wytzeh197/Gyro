import fs from "node:fs";

const port = process.env.CDP_PORT ?? "9344";
const url = process.env.TARGET_URL ??
  "http://127.0.0.1:1420/capture.html?scene=chat&theme=dark";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP target");
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    logs.push(String(msg.params.args.map((a) => a.value ?? a.description).join(" ")).slice(0, 200));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    logs.push("EXC " + String(msg.params.exceptionDetails.text + " " +
      (msg.params.exceptionDetails.exception?.description ?? "")).slice(0, 300));
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 520,
  height: 914,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Page.navigate", { url });
await sleep(8000);

const probe = `(() => {
  const out = { url: location.href };
  out.sidebar = !!document.querySelector(".gyro-sidebar");
  out.text = (document.body.innerText || "").slice(0, 200);
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim().startsWith("New Session"));
  out.foundButton = !!btn;
  if (!btn) return out;
  btn.click();
  const pop = document.querySelector(".gyro-sidebar-new-session-menu");
  out.foundPopover = !!pop;
  if (!pop) return out;
  const r = pop.getBoundingClientRect();
  out.popoverRect = { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
  const chain = [];
  let el = pop;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    chain.push({
      tag: el.tagName,
      cls: (el.className || "").toString().slice(0, 60),
      pos: cs.position, z: cs.zIndex, op: cs.opacity, tf: cs.transform,
      iso: cs.isolation, cont: cs.contain, ct: cs.containerType,
      wc: cs.willChange, bf: cs.backdropFilter, ovf: cs.overflow, bg: cs.backgroundColor,
      disp: cs.display,
    });
    el = el.parentElement;
  }
  out.chain = chain;
  const list = document.querySelector(".gyro-sidebar-project-chat-list");
  out.listFound = !!list;
  const probeYs = [];
  for (let i = 1; i <= 4; i++) probeYs.push(Math.round(r.top + (r.height * i) / 5));
  out.hits = probeYs.map((y) => {
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), y);
    const inPop = hit ? pop.contains(hit) || hit === pop : false;
    return { y, hit: hit ? hit.tagName + "." + (hit.className || "").toString().slice(0, 50) : null, inPop };
  });
  out.listRect = list ? list.getBoundingClientRect().toJSON() : null;
  return out;
})()`;

const res = await send("Runtime.evaluate", {
  expression: probe,
  returnByValue: true,
});
console.log(JSON.stringify(res.result?.result?.value ?? res, null, 1));
if (logs.length) console.log("LOGS:", logs.slice(0, 6).join("\n"));
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  fs.writeFileSync(process.env.SHOT_OUT ?? "/tmp/cdp-shot.png", Buffer.from(shot.result.data, "base64"));
  console.log("wrote shot");
}
process.exit(0);
