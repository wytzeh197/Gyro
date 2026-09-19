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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 520,
  height: 914,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Page.navigate", { url });
await sleep(7000);

const probe = `(() => {
  const out = {};
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").trim().startsWith("New Session"));
  out.foundButton = !!btn;
  if (btn) btn.click();
  const pop = document.querySelector(".gyro-sidebar-new-session-menu");
  out.foundPopover = !!pop;
  const chain = [];
  let el = pop;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    chain.push({
      tag: el.tagName,
      cls: el.className?.toString().slice(0, 70),
      position: cs.position,
      zIndex: cs.zIndex,
      transform: cs.transform,
      opacity: cs.opacity,
      filter: cs.filter,
      isolation: cs.isolation,
      contain: cs.contain,
      containerType: cs.containerType,
      willChange: cs.willChange,
      backdropFilter: cs.backdropFilter,
      overflow: cs.overflow,
      background: cs.backgroundColor,
      top: cs.top,
      height: cs.height?.slice(0, 12),
    });
    el = el.parentElement;
  }
  out.popoverChain = chain;
  const list = document.querySelector(".gyro-sidebar-project-chat-list");
  out.list = list ? {
    cls: list.className,
    position: getComputedStyle(list).position,
    zIndex: getComputedStyle(list).zIndex,
    background: getComputedStyle(list).backgroundColor,
    rect: list.getBoundingClientRect().toJSON(),
  } : null;
  out.popoverRect = pop ? pop.getBoundingClientRect().toJSON() : null;
  out.sidebarRect = document.querySelector(".gyro-sidebar")
    ?.getBoundingClientRect().toJSON() ?? null;
  return out;
})()`;

const res = await send("Runtime.evaluate", {
  expression: probe,
  returnByValue: true,
});
console.log(JSON.stringify(res.result?.result?.value ?? res, null, 1));

await sleep(1200);
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  fs.writeFileSync("/tmp/cdp-shot.png", Buffer.from(shot.result.data, "base64"));
  console.log("wrote /tmp/cdp-shot.png");
} else {
  console.log("no screenshot", JSON.stringify(shot).slice(0, 300));
}
process.exit(0);
