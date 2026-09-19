import fs from "node:fs";

const port = process.env.CDP_PORT ?? "9344";
const url = process.env.TARGET_URL ?? "http://127.0.0.1:1420/";
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
  const res = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (res.result?.exceptionDetails) {
    return { exception: res.result.exceptionDetails.text };
  }
  return res.result?.result?.value ?? res;
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
await sleep(9000);

// 1. Open the launcher menu.
console.log("click:", JSON.stringify(await evaluate(`(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim().startsWith("New Session"));
  if (!btn) return "no button";
  btn.click();
  return "clicked";
})()`)));
await sleep(700);

// 2. Inspect the popover, its ancestor chain, and the hit stack.
const result = await evaluate(`(() => {
  const out = {};
  const pop = document.querySelector(".gyro-sidebar-new-session-menu");
  out.foundPopover = !!pop;
  if (!pop) return out;
  const r = pop.getBoundingClientRect();
  out.popoverRect = { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  const chain = [];
  let el = pop;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    chain.push({
      tag: el.tagName,
      cls: (el.className || "").toString().slice(0, 55),
      disp: cs.display,
      pos: cs.position, z: cs.zIndex, op: cs.opacity, tf: cs.transform,
      iso: cs.isolation, cont: cs.contain, ct: cs.containerType,
      wc: cs.willChange, bf: cs.backdropFilter, ovf: cs.overflow,
      bg: cs.backgroundColor, anim: cs.animationName, fil: cs.filter,
    });
    el = el.parentElement;
  }
  out.chain = chain;
  const list = document.querySelector(".gyro-sidebar-project-chat-list");
  out.listFound = !!list;
  out.listCls = list ? (list.className || "").toString() : null;
  // Sample the hit stack at a point inside the popover that also lies over the
  // region the session list occupies.
  const x = Math.round(r.left + r.width / 2);
  out.stacks = [r.top + 12, r.top + 40, r.top + 80, r.top + 160]
    .filter((y) => y < r.bottom)
    .map((y) => ({
      y,
      stack: document.elementsFromPoint(x, y)
        .slice(0, 5)
        .map((e) => e.tagName + "." + (e.className || "").toString().split(" ").slice(0, 3).join(".")),
    }));
  return out;
})()`);
console.log(JSON.stringify(result, null, 1));

await sleep(500);
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  fs.writeFileSync(process.env.SHOT_OUT ?? "/tmp/cdp-probe.png", Buffer.from(shot.result.data, "base64"));
  console.log("wrote shot");
}
process.exit(0);
