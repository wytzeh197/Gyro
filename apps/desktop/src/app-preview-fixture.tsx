import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserPreviewSurface } from "@gyro-dev/ui";
import type { BrowserPreview } from "@gyro-dev/ui";
import type {
  AppPreviewRuntime,
  AppPreviewTarget,
} from "../../../packages/ui/src/app-preview-panel";
import "@gyro-dev/ui/styles.css";
const web: AppPreviewTarget = {
  id: "web",
  kind: "web",
  title: "Local counter · fixture",
  width: 800,
  height: 500,
};
const mac: AppPreviewTarget = {
  id: "macos:fixture",
  kind: "macos",
  title: "Counter window · fixture data",
  width: 800,
  height: 500,
};
const phone: AppPreviewTarget = {
  id: "simulator:fixture",
  kind: "simulator",
  title: "iPhone · fixture data",
  width: 390,
  height: 844,
};
let selected = web;
let count = 0;
let stale = false;
let disconnected = false;
let lastId = "";
let captureNumber = 0;
const params = new URLSearchParams(location.search);
if (params.has("debug"))
  setTimeout(() => {
    const report = document.createElement("pre");
    report.id = "layout-diagnostics";
    report.textContent = [
      ".gyro-app-preview",
      ".gyro-browser-preview",
      ".gyro-browser-preview-toolbar",
      ".gyro-browser-frame",
      ".gyro-preview-stage",
      ".gyro-browser-fitted-frame",
    ]
      .map((selector) => {
        const el = document.querySelector(selector);
        if (!el) return selector + ": missing";
        const css = getComputedStyle(el);
        return (
          selector +
          ": " +
          JSON.stringify({
            display: css.display,
            grid: css.gridTemplateColumns,
            height: el.getBoundingClientRect().height,
            width: el.getBoundingClientRect().width,
          })
        );
      })
      .join("\n");
    document.querySelector("nav")?.append(report);
  }, 3000);
const runtime: AppPreviewRuntime = {
  key: "fixture",
  targets: async () => ({
    selected,
    targets: [web, mac, phone],
    issues: [
      "Fixture targets only. Real macOS and iPhone runtimes are not connected to this page.",
    ],
  }),
  select: async (id) => {
    selected = [web, mac, phone].find((item) => item.id === id)!;
    return selected;
  },
  capture: async () => {
    if (disconnected) throw new Error("Runtime disconnected; capture is stale");
    lastId = "fixture-" + ++captureNumber;
    const w = selected.width,
      h = selected.height;
    const nativeImage = params.get("nativeImage");
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 20}" height="${h + 46}">
      <rect width="100%" height="100%" rx="20" fill="#29292c"/>
      <rect x="10" y="36" width="${w}" height="${h}" fill="#f6f6f7"/>
      <text x="42" y="95" font-family="system-ui" font-size="24" fill="#252527">Counter preview</text>
      <text x="42" y="135" font-family="system-ui" font-size="15" fill="#68686d">Rendered fixture · ${selected.kind}</text>
      <rect x="40" y="170" width="260" height="64" rx="12" fill="#326bc3"/>
      <text x="64" y="210" font-family="system-ui" font-size="21" fill="white">Increase count: ${count}</text>
      <text x="42" y="285" font-family="system-ui" font-size="14" fill="#68686d">Select “Click to inspect”, then click the button.</text></svg>`;
    return {
      target: selected,
      screenshot: {
        path: lastId,
        filename: lastId,
        width: w + 20,
        height: h + 46,
        createdAt: new Date(Date.now() - (stale ? 60000 : 0)).toISOString(),
        src: nativeImage || "data:image/svg+xml," + encodeURIComponent(image),
      },
      contentRect: { x: 10, y: 36, width: w, height: h },
      expiresAfterMs: 15000,
      interaction: selected.kind === "simulator" ? "capture-only" : "click",
    };
  },
  click: async (id, x, y) => {
    if (id !== lastId || stale || disconnected)
      throw new Error("Capture is stale");
    if (x >= 40 && x <= 300 && y >= 170 && y <= 234) count++;
    document.querySelector("#coordinate-result")!.textContent =
      `Mapped image coordinates: ${x.toFixed(1)}, ${y.toFixed(1)} · Count ${count}`;
  },
  subscribe: () => () => {},
};
const preview: BrowserPreview = {
  url: new URL("/browser-pointer-fixture.html", location.href).href,
  history: [],
  historyIndex: -1,
  device: "desktop",
  status: "ready",
  captureStatus: "idle",
  consoleErrors: 0,
  diagnostics: [],
  diagnosticsSupported: false,
  diagnosticsCaptured: false,
  verificationMessage: "Fixture web page",
  runtime,
};
document.documentElement.dataset.theme = params.get("theme") || "light";
createRoot(document.getElementById("root")!).render(
  <main
    style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "var(--gyro-pane)",
      color: "var(--gyro-text)",
    }}
  >
    <nav
      style={{
        padding: 12,
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        font: "12px system-ui",
      }}
    >
      <strong>App Preview · component fixture</strong>
      <button
        onClick={() => {
          stale = !stale;
        }}
      >
        Toggle stale captures
      </button>
      <button
        onClick={() => {
          disconnected = !disconnected;
        }}
      >
        Toggle disconnected runtime
      </button>
      <output id="coordinate-result">No input dispatched</output>
    </nav>
    <div
      className="gyro-chat-companion gyro-chat-companion-content"
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "minmax(0, 1fr)",
        width: "100%",
        maxWidth: params.has("narrow") ? 360 : 760,
        margin: "0 auto",
        border: "1px solid var(--gyro-border-soft)",
      }}
    >
      <BrowserPreviewSurface browserPreview={preview} variant="chat" />
    </div>
  </main>,
);
