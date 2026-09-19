import fs from "node:fs";

const port = process.env.CDP_PORT ?? "9344";
const url = process.env.TARGET_URL ?? "http://127.0.0.1:1420/";
const vw = Number(process.env.VW ?? 520);
const vh = Number(process.env.VH ?? 914);
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
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
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
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) return { exception: res.result.exceptionDetails.text };
  return res.result?.result?.value ?? res;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: vw,
  height: vh,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url });
await sleep(9000);

console.log("state:", JSON.stringify(await evaluate(`(() => ({
  sidebarDisplay: getComputedStyle(document.querySelector(".gyro-sidebar") || document.body).display,
  text: (document.body.innerText || "").slice(0, 120),
}))()`)));

console.log("click:", JSON.stringify(await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim().startsWith("New Session"));
  if (!btn) return "no button";
  btn.click();
  return "clicked";
})()`)));
await sleep(800);

const result = await evaluate(`(() => {
  const out = {};
  const pop = document.querySelector(".gyro-sidebar-new-session-menu");
  out.foundPopover = !!pop;
  if (!pop) return out;
  const r = pop.getBoundingClientRect();
  out.popoverRect = { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  const info = (el) => {
    const cs = getComputedStyle(el);
    return {
      cls: (el.className || "").toString().split(" ").slice(0, 2).join("."),
      pos: cs.position, z: cs.zIndex, op: cs.opacity, tf: cs.transform,
      anim: cs.animationName, fil: cs.filter, disp: cs.display, ovf: cs.overflow,
    };
  };
  out.popover = info(pop);
  const actions = document.querySelector(".gyro-sidebar-actions");
  const list = document.querySelector(".gyro-sidebar-project-chat-list");
  out.actions = actions ? info(actions) : null;
  out.list = list ? info(list) : null;
  out.listRect = list ? (() => { const b = list.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; })() : null;
  out.sessionRows = document.querySelectorAll(".gyro-session-row").length;
  const x = Math.round(r.left + r.width / 2);
  out.stacks = [r.top + 10, r.top + 60, r.top + 120, r.top + 200, r.top + 280]
    .filter((y) => y > r.top && y < r.bottom)
    .map((y) => ({
      y,
      stack: document.elementsFromPoint(x, y).slice(0, 4).map((e) =>
        e.tagName + "." + (e.className || "").toString().split(" ").slice(0, 2).join(".")),
    }));
  return out;
})()`);
console.log(JSON.stringify(result, null, 1));

await sleep(600);
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  fs.writeFileSync(process.env.SHOT_OUT ?? "/tmp/cdp-probe3.png", Buffer.from(shot.result.data, "base64"));
  console.log("wrote shot");
}
process.exit(0);
