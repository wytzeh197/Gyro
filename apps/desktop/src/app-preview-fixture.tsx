import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserPreviewSurface } from "@gyro-dev/ui";
import type { BrowserPreview } from "@gyro-dev/ui";
import type {
  AppPreviewRuntime,
  AppPreviewTarget,
} from "../../../packages/ui/src/app-preview-panel";
import type { XcodeSetup } from "../../../packages/ui/src/app-preview-xcode-setup";
import "@gyro-dev/ui/styles.css";
const params = new URLSearchParams(location.search);
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
  title:
    params.get("device") === "macbook"
      ? "Fieldnotes"
      : "Counter window · fixture data",
  width: 800,
  height: 500,
};
const phone: AppPreviewTarget = {
  id: "simulator:fixture",
  kind: "simulator",
  title: "iPhone 17 Pro",
  width: 1206,
  height: 2622,
  deviceFamily: "iPhone",
  deviceType: "iPhone-17-Pro",
  booted: true,
};
const phoneVariants: AppPreviewTarget[] = [
  {
    id: "simulator:iphone-12",
    deviceType: "iPhone-12",
    title: "iPhone 12",
    width: 1170,
    height: 2532,
  },
  {
    id: "simulator:iphone-13-mini",
    deviceType: "iPhone-13-mini",
    title: "iPhone 13 mini",
    width: 1080,
    height: 2340,
  },
  {
    id: "simulator:iphone-14-pro",
    deviceType: "iPhone-14-Pro",
    title: "iPhone 14 Pro",
    width: 1179,
    height: 2556,
  },
  {
    id: "simulator:iphone-14-pro-max",
    deviceType: "iPhone-14-Pro-Max",
    title: "iPhone 14 Pro Max",
    width: 1290,
    height: 2796,
  },
  {
    id: "simulator:iphone-17-pro-max",
    deviceType: "iPhone-17-Pro-Max",
    title: "iPhone 17 Pro Max",
    width: 1320,
    height: 2868,
  },
].map((variant) => ({
  ...variant,
  kind: "simulator",
  deviceFamily: "iPhone",
  booted: true,
}));
const tablet: AppPreviewTarget = {
  id: "simulator:tablet-fixture",
  kind: "simulator",
  title: "iPad Air 11-inch",
  width: params.has("portrait") ? 1640 : 2360,
  height: params.has("portrait") ? 2360 : 1640,
  deviceFamily: "iPad",
  booted: true,
};
const targets = [web, mac, phone, ...phoneVariants, tablet];
let selected =
  params.get("device") === "ipad"
    ? tablet
    : params.get("device") === "macbook"
      ? mac
      : params.has("device")
        ? (phoneVariants.find(
            (variant) => variant.id === `simulator:${params.get("device")}`,
          ) ?? phone)
        : web;
let count = 0;
let stale = false;
let disconnected = false;
let lastId = "";
let captureNumber = 0;
let buildNumber = 0;
function phoneBitmap(target: AppPreviewTarget) {
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(3, 3);
  const w = target.width / 3;
  const h = target.height / 3;
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    color: string,
    weight = 400,
  ) => {
    ctx.font = `${weight} ${size}px -apple-system, system-ui`;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  const rounded = (
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    color: string,
  ) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
  };
  ctx.fillStyle = "#f7f7f9";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, 115);
  text("9:41", 40, 38, 15, "#17171a", 600);
  rounded(w - 60, 25, 26, 13, 4, "#252527");
  rounded(w - 32, 29, 2, 5, 1, "#252527");
  text("‹ Notes", 19, 92, 18, "#0068d7", 500);
  text("Fieldnotes", w / 2 - 48, 92, 17, "#17171a", 650);
  const share = w - (buildNumber > 1 ? 88 : 69);
  ctx.strokeStyle = "#0068d7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(share, 78, 14, 16, 3);
  ctx.stroke();
  text("↑", share + 2, 84, 18, "#0068d7", 650);
  text("•••", w - 35, 92, 13, "#0068d7", 650);
  ctx.fillStyle = "#e8e8ed";
  ctx.fillRect(0, 115, w, 1);
  text("Coastal walk", 25, 166, 32, "#17171a", 700);
  text("A quiet stretch of coast this morning.", 25, 210, 16, "#313137");
  text("Low tide revealed smooth stones and", 25, 234, 16, "#313137");
  text("tide pools beneath the bluff.", 25, 258, 16, "#313137");
  text("Come back next weekend to explore", 25, 306, 16, "#313137");
  text("the northern trail.", 25, 330, 16, "#313137");
  rounded((w - 138) / 2, h - 22, 138, 5, 3, "#17171a");
  return canvas.toDataURL("image/png");
}
function wideBitmap(target: AppPreviewTarget) {
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d")!;
  const scale = target.kind === "macos" ? 1 : 2;
  ctx.scale(scale, scale);
  const w = target.width / scale;
  const h = target.height / scale;
  const sidebar = w > h ? Math.round(w * 0.3) : 0;
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    color: string,
    weight = 400,
  ) => {
    ctx.font = `${weight} ${size}px -apple-system, system-ui`;
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  };
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f5f5f8";
  ctx.fillRect(0, 0, sidebar, h);
  ctx.fillStyle = "#e4e5ea";
  ctx.fillRect(sidebar, 0, 1, h);
  if (target.kind === "macos") {
    for (const [index, color] of ["#ed665f", "#f3bb49", "#5cc75f"].entries()) {
      ctx.beginPath();
      ctx.arc(18 + 17 * index, 20, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    text("Fieldnotes", 72, 26, 15, "#17171a", 650);
  } else {
    text("9:41", 24, 25, 15, "#17171a", 600);
    text("100%", w - 63, 25, 14, "#17171a", 600);
    ctx.beginPath();
    ctx.roundRect((w - 128) / 2, h - 12, 128, 5, 3);
    ctx.fillStyle = "#17171a";
    ctx.fill();
  }
  text("‹ Notes", 24, 85, 21, "#0068d7", 650);
  if (sidebar) {
    ctx.beginPath();
    ctx.roundRect(14, 109, sidebar - 28, 44, 9);
    ctx.fillStyle = "#dbeaff";
    ctx.fill();
    text("Coastal walk", 24, 137, 17, "#153a6a", 600);
    text("Studio ideas", 24, 185, 17, "#313137");
    text("Reading list", 24, 228, 17, "#313137");
  }
  const x = sidebar + 30;
  const titleBaseline = sidebar ? 94 : 141;
  text("Coastal walk", x, titleBaseline, 33, "#17171a", 700);
  text(
    "A quiet stretch of coast this morning.",
    x,
    titleBaseline + 46,
    18,
    "#313137",
  );
  text("Low tide revealed smooth stones", x, titleBaseline + 72, 18, "#313137");
  text(
    "and tide pools beneath the bluff.",
    x,
    titleBaseline + 98,
    18,
    "#313137",
  );
  return canvas.toDataURL("image/png");
}

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
const setupStates: XcodeSetup["state"][] = [
  "missing",
  "incompatible",
  "first-launch",
  "runtime",
  "devices",
  "ready",
  "error",
];
let xcodeState = setupStates.find((state) => state === params.get("setup"));
const reportSetupAction = (message: string) => {
  document.querySelector("#coordinate-result")!.textContent = message;
};
const runtime: AppPreviewRuntime = {
  key: "fixture",
  targets: async () => ({
    selected,
    targets:
      xcodeState && xcodeState !== "ready"
        ? targets.filter((target) => target.kind !== "simulator")
        : targets,
    issues: [
      "Fixture targets only. Real macOS and iPhone runtimes are not connected to this page.",
    ],
  }),
  select: async (id) => {
    selected = targets.find((item) => item.id === id)!;
    return selected;
  },
  capture: async () => {
    if (disconnected) throw new Error("Runtime disconnected; capture is stale");
    lastId = "fixture-" + ++captureNumber;
    const w = selected.width,
      h = selected.height;
    if (
      selected.kind === "simulator" ||
      (selected.kind === "macos" && params.get("device") === "macbook")
    ) {
      return {
        target: selected,
        screenshot: {
          path: lastId,
          filename: lastId,
          width: w,
          height: h,
          createdAt: new Date().toISOString(),
          src:
            selected.deviceFamily === "iPhone"
              ? phoneBitmap(selected)
              : wideBitmap(selected),
        },
        contentRect: { x: 0, y: 0, width: w, height: h },
        expiresAfterMs: 15000,
        interaction: selected.kind === "macos" ? "click" : "capture-only",
      };
    }
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
      interaction: "click",
    };
  },
  click: async (id, x, y) => {
    if (id !== lastId || stale || disconnected)
      throw new Error("Capture is stale");
    if (x >= 40 && x <= 300 && y >= 170 && y <= 234) count++;
    document.querySelector("#coordinate-result")!.textContent =
      `Mapped image coordinates: ${x.toFixed(1)}, ${y.toFixed(1)} · Count ${count}`;
  },
  schemes: async () => [
    { project: "Fieldnotes.xcodeproj", name: "Fieldnotes" },
  ],
  run: async () => {
    ++buildNumber;
    return runtime.capture();
  },
  xcodeSetup: xcodeState
    ? {
        check: async () => ({
          state: xcodeState ?? "missing",
          macos: "26.2",
          xcode:
            xcodeState === "missing"
              ? null
              : xcodeState === "incompatible"
                ? "Xcode 27.2"
                : "Xcode 26.6",
          detail:
            xcodeState === "error"
              ? "Simulator could not list its runtimes."
              : null,
          download: { kind: "version", version: "26.6" },
          devices: xcodeState === "ready" ? [phone, tablet] : [],
        }),
        download: async () =>
          reportSetupAction("Apple Developer download requested · fixture"),
        choose: async () => {
          xcodeState = "first-launch";
          reportSetupAction("Xcode selected · fixture");
        },
        open: async () => {
          reportSetupAction("Xcode opened · fixture");
          xcodeState = xcodeState === "first-launch" ? "runtime" : "ready";
        },
      }
    : undefined,
  openDevice: async () => {
    document.querySelector("#coordinate-result")!.textContent =
      "Device Hub requested · fixture";
  },
  simulatorFrame: async () => {
    const capture = await runtime.capture();
    return {
      ...capture,
      screenshot: { ...capture.screenshot, filename: "", path: "" },
    };
  },
  subscribe: () => () => {},
};
const preview: BrowserPreview = {
  url: params.has("blank")
    ? ""
    : new URL("/browser-pointer-fixture.html", location.href).href,
  history: [],
  historyIndex: -1,
  device: "desktop",
  status: params.has("blank") ? "idle" : "ready",
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
        maxWidth: params.has("narrow") ? 320 : 720,
        margin: "0 auto",
        border: "1px solid var(--gyro-border-soft)",
      }}
    >
      <BrowserPreviewSurface
        browserPreview={preview}
        variant="chat"
        nativeHost={params.has("nativeHost")}
        onHostBoundsChange={
          params.has("nativeHost")
            ? (bounds) => {
                document.body.dataset.fixtureHost = bounds
                  ? "visible"
                  : "hidden";
              }
            : undefined
        }
        onScreenshot={(action, feedback) => {
          if (action !== "annotate-native-send" || !feedback?.nativeCapture)
            return;
          document.querySelector("#coordinate-result")!.textContent =
            JSON.stringify(feedback.nativeCapture.region);
          return { sent: true };
        }}
      />
    </div>
  </main>,
);
