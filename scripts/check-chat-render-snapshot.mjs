#!/usr/bin/env node

// Rendered-value snapshot of the chat screen.
//
// Opens the capture harness (apps/desktop/capture.html) in a headless browser
// and records what the chat actually renders: edges, sizes, type, radii,
// borders and fills for the elements of a turn, the composer and the top bar.
// The result is compared with scripts/chat-render-baseline.json.
//
// This checks the outcome of the CSS, not its source text, so stylesheet rules
// can be moved, merged or deleted freely as long as the chat renders the same.
// See docs/design/chat-consolidation-plan-2026-11-10.md.
//
//   node scripts/check-chat-render-snapshot.mjs            compare
//   node scripts/check-chat-render-snapshot.mjs --update   rewrite the baseline
//   node scripts/check-chat-render-snapshot.mjs --shots    also save screenshots
//
// Needs the desktop Vite dev server (pnpm --filter @gyro-dev/desktop dev, or
// pnpm dev) on GYRO_TEST_ORIGIN, default http://127.0.0.1:1420.
//
// Text is measured by the local browser, so heights and text-driven widths can
// move by a pixel between machines or browser versions. Compare against a
// baseline recorded on the same machine.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  measureChatContract,
  checkChatContract,
} from "./chat-render-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const baselinePath = resolve(
  repoRoot,
  argument("--baseline") ?? "scripts/chat-render-baseline.json",
);
const shotRoot = resolve(repoRoot, "artifacts/screenshots/chat-render");
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
const debugPort = Number(process.env.GYRO_BROWSER_DEBUG_PORT ?? "9392");
const update = process.argv.includes("--update");
const extended = process.argv.includes("--extended");
const navigation = process.argv.includes("--navigation");
const pixels = process.argv.includes("--pixels");
const recordPixels = process.argv.includes("--record-pixels");
const recordBaseline = process.argv.includes("--record-baseline");
const inventory = process.argv.includes("--inventory");
const invariantsOnly = process.argv.includes("--invariants-only");
const auditInvariants =
  invariantsOnly || process.argv.includes("--audit-invariants");
// Every comparison uses the same onboarded, settled fixture state as updates.
const settledCapture = true;
const pixelRoot = resolve(
  repoRoot,
  argument("--pixel-root") ?? "artifacts/chat-consolidation/pixels-before",
);
const saveShots =
  process.argv.includes("--shots") || update || pixels || recordPixels;
if (recordBaseline && !argument("--baseline"))
  throw new Error(
    "--record-baseline needs an explicit --baseline path; the original baseline is protected.",
  );
const filter = process.env.GYRO_SNAPSHOT_FILTER;

const playwrightCache = resolve(homedir(), "Library/Caches/ms-playwright");
const cachedHeadlessShells = existsSync(playwrightCache)
  ? readdirSync(playwrightCache)
      .filter((entry) => entry.startsWith("chromium_headless_shell-"))
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true }),
      )
      .map((entry) =>
        resolve(
          playwrightCache,
          entry,
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
      )
  : [];
const browserPath = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ...cachedHeadlessShells,
].find((candidate) => candidate && existsSync(candidate));

// Each probe is the first visible match of its selector. A probe that a scene
// does not render is recorded as null, so a disappearing element is a diff.
const threadProbes = {
  surface: ".gyro-chat-surface",
  topbar: ".gyro-chat-thread-topbar",
  topbarTitle: ".gyro-chat-thread-identity",
  topbarButton: ".gyro-chat-surface-button",
  canvas: ".gyro-chat-thread-canvas",
  turn: ".gyro-chat-turn",
  userBubble: ".gyro-user-message-bubble",
  userMeta: ".gyro-user-message-meta",
  runHeader: ".gyro-run-header",
  runHeaderToggle: ".gyro-run-header-toggle",
  response: ".gyro-response",
  responseBody: ".gyro-response-body",
  responseInlineCode: ".gyro-response-inline-code",
  responseActions: ".gyro-response-actions",
  changeSummary: ".gyro-chat-run-change-summary",
  changeSummaryFile: ".gyro-change-summary-file",
  changeFilePath: ".gyro-change-file-path",
  composerDock: ".gyro-chat-composer-dock",
  composer: ".gyro-composer-shell",
  composerInput:
    ".gyro-composer-shell textarea, .gyro-composer-shell [contenteditable]",
  composerBar: ".gyro-composer-bar",
  composerChip: ".gyro-composer-chip",
  composerTool: ".gyro-composer-tool",
  sendButton: ".gyro-send-button",
  environment: ".gyro-chat-environment-popover",
  environmentRow: ".gyro-environment-row",
};
const startProbes = {
  surface: ".gyro-chat-surface",
  start: ".gyro-chat-start",
  startBrandWord: ".gyro-chat-start-brand-word",
  composer: ".gyro-composer-shell",
  composerInput:
    ".gyro-composer-shell textarea, .gyro-composer-shell [contenteditable]",
  composerBar: ".gyro-composer-bar",
  composerChip: ".gyro-composer-chip",
  composerTool: ".gyro-composer-tool",
  sendButton: ".gyro-send-button",
  summaryChip: ".gyro-context-summary-item",
};

// Only present while a run is live.
const streamingProbes = {
  ...threadProbes,
  liveRun: ".gyro-run.is-live",
  liveSayRow: ".gyro-run-row.is-say",
  liveSegmentToggle: ".gyro-run-segment-toggle",
  liveCall: ".gyro-run-call.is-running",
  liveCallIcon: ".gyro-run-call.is-running .gyro-run-row-icon",
  liveCallVerb: ".gyro-run-call-verb",
  liveCallTarget: ".gyro-run-call-target",
};

// Markdown the plain thread fixture never renders.
const codeProbes = {
  ...threadProbes,
  codeBlock: ".gyro-response-code-block",
  codeBlockCode: ".gyro-response-code-block code",
  responseParagraph: ".gyro-response-body p",
  responseList: ".gyro-response-body ul",
  responseListItem: ".gyro-response-body li",
};

// The thread probes measure the first pane; these measure the one beside it.
const secondPane = ".gyro-chat-grid-slot.is-occupied ~ .gyro-chat-grid-slot";
const splitProbes = {
  ...threadProbes,
  grid: ".gyro-chat-grid",
  gridSash: ".gyro-chat-grid-sash",
  firstPane: ".gyro-chat-grid-slot.is-occupied",
  secondPane,
  secondTopbar: `${secondPane} .gyro-chat-thread-topbar`,
  secondTopbarTitle: `${secondPane} .gyro-chat-thread-identity`,
  secondCanvas: `${secondPane} .gyro-chat-thread-canvas`,
  secondTurn: `${secondPane} .gyro-chat-turn`,
  secondUserBubble: `${secondPane} .gyro-user-message-bubble`,
  secondRunHeader: `${secondPane} .gyro-run-header`,
  secondResponse: `${secondPane} .gyro-response`,
  secondComposer: `${secondPane} .gyro-composer-shell`,
  secondComposerBar: `${secondPane} .gyro-composer-bar`,
  secondSendButton: `${secondPane} .gyro-send-button`,
};

const scenes = navigation
  ? [
      {
        name: "approval",
        scene: "active-chat",
        edge: "inline-approval",
        clicks: ["?Skip tour"],
        probes: threadProbes,
      },
      {
        name: "question",
        scene: "active-chat",
        edge: "question",
        clicks: ["Bound the sync", "?Skip tour"],
        probes: threadProbes,
      },
      {
        name: "three",
        scene: "active-chat",
        edge: "three",
        clicks: ["?Skip tour"],
        probes: splitProbes,
      },
    ]
  : [
      { name: "start", scene: "welcome", clicks: [], probes: startProbes },
      {
        name: "setup",
        scene: "welcome",
        edge: "disconnected",
        clicks: [],
        probes: startProbes,
      },
      {
        name: "thread",
        scene: "active-chat",
        clicks: ["Bound the sync", "?Skip tour"],
        probes: threadProbes,
      },
      // The three below are fixture-only states (see `chatEdge` in
      // apps/desktop/src/capture-fixtures.ts). They open on the thread directly and
      // are recorded at the default interface size only.
      {
        name: "streaming",
        scene: "active-chat",
        edge: "streaming",
        clicks: ["?Skip tour"],
        // The app only shows a run as live when its own composer sent it.
        send: "The sync queue retries forever when the server returns 503. Add a bounded retry with backoff, and cover it with a test.",
        probes: streamingProbes,
        sizes: ["default"],
      },
      {
        name: "code",
        scene: "active-chat",
        edge: "code-block",
        clicks: ["?Skip tour"],
        probes: codeProbes,
        sizes: ["default"],
      },
      {
        name: "split",
        scene: "active-chat",
        edge: "split",
        clicks: ["?Skip tour"],
        probes: splitProbes,
        sizes: ["default"],
      },
    ];
if (extended && !navigation)
  scenes.push(
    {
      name: "environment",
      scene: "active-chat",
      edge: "code-block",
      clicks: ["?Skip tour"],
      probes: threadProbes,
      openEnvironment: true,
    },
    {
      name: "environment-streaming",
      scene: "active-chat",
      edge: "streaming",
      clicks: ["?Skip tour"],
      send: "Check the chat layout while this response is running.",
      probes: streamingProbes,
      openEnvironment: true,
    },
    {
      name: "lists",
      scene: "active-chat",
      edge: "markdown-lists",
      clicks: ["?Skip tour"],
      probes: codeProbes,
    },
    {
      name: "stacked",
      scene: "active-chat",
      edge: "stacked",
      clicks: ["?Skip tour"],
      probes: splitProbes,
    },
    {
      name: "three",
      scene: "active-chat",
      edge: "three",
      clicks: ["?Skip tour"],
      probes: splitProbes,
    },
  );
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 900, height: 700 },
];
const themes = ["dark", "light"];
// Interface size scales --gyro-ui-scale, which most chat lengths multiply by.
// Density is left at the harness default: it only restyles the sidebar and
// settings, so it would double the run without measuring anything in the chat.
const sizes = ["default", "small", "large"];

let states = scenes.flatMap((scene) =>
  (scene.openEnvironment
    ? [
        ...viewports,
        { name: "laptop", width: 1280, height: 800 },
        { name: "compact", width: 1024, height: 768 },
      ]
    : viewports
  ).flatMap((viewport) =>
    themes.flatMap((theme) =>
      (extended ? sizes : (scene.sizes ?? sizes)).map((size) => ({
        ...scene,
        ...viewport,
        theme,
        size,
        name: `${scene.name}-${viewport.name}-${theme}-${size}`,
        url: `${origin}/capture.html?scene=${scene.scene}&theme=${theme}&size=${size}${scene.edge ? `&edge=${scene.edge}` : ""}&reset=1${settledCapture ? "&tour=skip" : ""}`,
      })),
    ),
  ),
);
if (extended && !navigation) {
  for (const [name, edge, selector] of [
    ["composer", "code-block", ".gyro-composer-input > textarea"],
    ["send", "code-block", ".gyro-send-button"],
    ["work", "streaming", ".gyro-run-call.is-running"],
    ["file", "code-block", ".gyro-change-summary-file"],
  ])
    for (const pseudo of ["hover", "focus-visible"])
      for (const theme of themes) {
        const base = states.find(
          (s) =>
            s.edge === edge &&
            s.width === 1440 &&
            s.theme === theme &&
            s.size === "default",
        );
        states.push({
          ...base,
          name: `interaction-${name}-${pseudo}-${theme}`,
          pseudo: {
            selector,
            classes: [pseudo],
          },
          draft: name === "send" ? "Check the bounded retry." : undefined,
        });
      }
}
states = states.filter((state) => !filter || state.name.includes(filter));
if (!states.length) throw new Error(`No states match ${filter}`);

// Runs in the page. Colours are kept as the browser reports them; lengths are
// rounded to whole pixels so sub-pixel text metrics do not flap.
const measure = (probes) => `(() => {
  const probes = ${JSON.stringify(probes)};
  const px = (value) => Math.round(parseFloat(value) || 0);
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const sides = (style, name, suffix = "") =>
    ["Top", "Right", "Bottom", "Left"]
      .map((side) => px(style[name + side + suffix]))
      .join(" ");
  const out = {};
  for (const [name, selector] of Object.entries(probes)) {
    const node = [...document.querySelectorAll(selector)].find(visible);
    if (!node) {
      out[name] = null;
      continue;
    }
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    out[name] = {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fontSize: px(style.fontSize),
      lineHeight: style.lineHeight === "normal" ? "normal" : px(style.lineHeight),
      fontWeight: style.fontWeight,
      color: style.color,
      background: style.backgroundColor,
      radius: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map(px).join(" "),
      borderWidth: sides(style, "border", "Width"),
      borderColor: style.borderTopColor,
      padding: sides(style, "padding"),
      gap: style.gap,
      boxShadow: style.boxShadow,
    };
  }
  return out;
})()`;

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // keep polling
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

if (!browserPath) {
  throw new Error(
    "No browser found. Set GYRO_CAPTURE_BROWSER to a Chromium-based browser.",
  );
}
try {
  if (!(await fetch(`${origin}/capture.html`)).ok) throw new Error("not ok");
} catch {
  throw new Error(
    `The desktop dev server is not answering at ${origin}. Start it with "pnpm --filter @gyro-dev/desktop dev" or set GYRO_TEST_ORIGIN.`,
  );
}

const profile = mkdtempSync(resolve(tmpdir(), "gyro-chat-render-"));
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=BraveRewards,BraveVPN",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const snapshot = {};
const pixelFailures = [];
const contractFailures = [];
const contracts = {};
let wroteInventory = false;
let socket;
try {
  const version = await waitFor(
    async () =>
      (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(),
    "browser debug port",
  );
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((opened, failed) => {
    socket.addEventListener("open", opened);
    socket.addEventListener("error", () =>
      failed(new Error("devtools websocket failed")),
    );
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params, sessionId) =>
    new Promise((resolveCall, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, 20_000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  if (saveShots) mkdirSync(shotRoot, { recursive: true });
  for (const state of states) {
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails)
        throw new Error(`${state.name}: ${exceptionDetails.text}`);
      return result.value;
    };
    await call("Page.enable");
    await call("Runtime.enable");
    if (settledCapture)
      await call("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => { const NativeDate = Date; const now = NativeDate.parse('2026-11-10T08:00:00Z'); globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }; })();`,
      });
    await call("Emulation.setDeviceMetricsOverride", {
      width: state.width,
      height: state.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: state.url });
    await call("Page.bringToFront");
    await waitFor(
      () =>
        evaluate(
          "Boolean(document.querySelector('.gyro-app-shell')) && !document.querySelector('.gyro-early-shell')",
        ),
      `${state.name} app shell`,
    );
    await pause(800);
    // Restore must finish before a fixture can stand in for a populated pane.
    // Startup validation can briefly replace persisted session slots with drafts
    // before list_sessions resolves. Retry the disposable fixture once, then
    // fail rather than silently snapshotting the wrong scene.
    if (
      settledCapture &&
      ["code-block", "markdown-lists", "split", "stacked", "three"].includes(
        state.edge,
      )
    ) {
      const count =
        state.edge === "three"
          ? 3
          : ["code-block", "markdown-lists"].includes(state.edge)
            ? 1
            : 2;
      const ready = () =>
        evaluate(`(() => {
        const panes = [...document.querySelectorAll('.gyro-chat-surface')];
        return panes.length === ${count} && panes.every(pane => pane.classList.contains('is-thread') && pane.querySelector('.gyro-user-message-bubble'));
      })()`);
      try {
        await waitFor(ready, `${state.name} restored pane fixtures`, 5000);
      } catch {
        console.log(`retrying ${state.name} fixture hydration`);
        await call("Page.navigate", { url: state.url });
        await waitFor(
          ready,
          `${state.name} restored pane fixtures after reload`,
          15_000,
        );
      }
    }
    // A leading "?" marks a click that is skipped when its target is absent.
    for (const entry of state.clicks) {
      if (settledCapture && entry === "?Skip tour") continue;
      const optional = entry.startsWith("?");
      const click = optional ? entry.slice(1) : entry;
      const attempt = () =>
        evaluate(`(() => {
        const wanted = ${JSON.stringify(click)};
        const node = [...document.querySelectorAll('button, [role="button"], a')]
          .filter((node) => (node.textContent || '').trim().startsWith(wanted))
          .sort((a, b) => a.textContent.length - b.textContent.length)[0];
        node?.click();
        return Boolean(node);
      })()`);
      // Optional targets (the first-run tour) mount late, so give them a moment.
      // The shell can paint before the project list finishes hydrating. Wait
      // for required controls instead of treating a slower cold load as a
      // rendering regression (or measuring the empty start screen).
      let clicked = optional
        ? await attempt()
        : await waitFor(attempt, `${state.name} control "${click}"`);
      for (let tries = 0; !clicked && optional && tries < 12; tries += 1) {
        await pause(250);
        clicked = await attempt();
      }
      if (!clicked && !optional)
        throw new Error(`${state.name}: nothing to click "${click}"`);
      await pause(700);
    }
    if (state.send) {
      const focused = await evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(threadProbes.composerInput)});
        input?.focus();
        return Boolean(input);
      })()`);
      if (!focused) throw new Error(`${state.name}: no composer to type in`);
      await call("Input.insertText", { text: state.send });
      await pause(200);
      for (const type of ["keyDown", "keyUp"]) {
        await call("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: type === "keyDown" ? "\r" : undefined,
        });
      }
      await pause(1200);
    }
    if (state.openEnvironment) {
      await waitFor(
        () =>
          evaluate(`(() => {
          if (document.querySelector(".gyro-chat-environment-popover")) return true;
          document.querySelector('button[aria-label="Environment"]')?.click();
          return Boolean(document.querySelector(".gyro-chat-environment-popover"));
        })()`),
        `${state.name} open Environment`,
      );
      await pause(700);
    }
    if (state.draft) {
      await evaluate(
        `document.querySelector(${JSON.stringify(threadProbes.composerInput)}).focus()`,
      );
      await call("Input.insertText", { text: state.draft });
      await waitFor(
        () => evaluate("!document.querySelector('.gyro-send-button').disabled"),
        `${state.name} enabled send`,
      );
    }
    // Let fonts and enter transitions finish, then freeze what is left so the
    // measurement does not land mid-animation.
    await evaluate("document.fonts.ready.then(() => true)");
    await pause(600);
    if (settledCapture) {
      await waitFor(
        () =>
          evaluate(
            `Boolean(document.querySelector('.gyro-sidebar')) && [...document.querySelectorAll('.gyro-sidebar button')].some(n => (n.textContent || '').trim().startsWith('Bound the sync'))`,
          ),
        `${state.name} populated sidebar`,
      );
      await evaluate(
        "new Promise(resolve => { const timeout = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); })); })",
      );
      await waitFor(
        () =>
          evaluate(
            "!document.querySelector('.gyro-workspace-preparation') && !document.querySelector('.gyro-shell-optimizing[role=status]')",
          ),
        `${state.name} settled preparation`,
      );
      if (state.name.startsWith("thread-")) {
        let retried = false;
        await waitFor(async () => {
          const status = await evaluate(`(() => {
            if (document.querySelector('.gyro-chat-surface.is-thread .gyro-user-message-bubble')) return 'ready';
            const button = [...document.querySelectorAll('.gyro-sidebar button')].find(n => (n.textContent || '').trim().startsWith('Bound the sync'));
            if (button) { button.click(); return 'clicked'; }
            return 'waiting';
          })()`);
          if (status === "clicked") retried = true;
          return status === "ready";
        }, `${state.name} hydrated conversation`);
        if (retried) await pause(500);
      }
    }
    await evaluate(`(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }';
      document.head.append(style);
      return true;
    })()`);
    if (settledCapture)
      await evaluate(`(async () => {
      for (let pass = 0; pass < 3; pass++) {
        for (const animation of document.getAnimations()) {
          if (animation.effect?.getComputedTiming().endTime !== Infinity) {
            try { animation.finish(); } catch {}
          }
        }
        await new Promise(resolve => { const timeout = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); })); });
      }
      return true;
    })()`);
    if (state.pseudo) {
      await call("DOM.enable");
      await call("CSS.enable");
      const { root } = await call("DOM.getDocument");
      const { nodeId } = await call("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: state.pseudo.selector,
      });
      if (!nodeId)
        throw new Error(
          `${state.name}: missing pseudo-state target ${state.pseudo.selector}`,
        );
      await call("CSS.forcePseudoState", {
        nodeId,
        forcedPseudoClasses: state.pseudo.classes,
      });
    }
    // A thread taller than its pane sits at the bottom, at a fractional offset
    // that rounds either way. Pin every scrolled box to a whole pixel.
    await evaluate(`(() => {
      for (const node of document.querySelectorAll('.gyro-chat-grid *, .gyro-chat-surface *')) {
        if (node.scrollTop > 0) node.scrollTop = Math.floor(node.scrollHeight - node.clientHeight);
      }
      return true;
    })()`);
    await pause(100);
    // A late development reload can occur after the first hydration check.
    // Never record an empty or wrong scene as the accepted local baseline.
    const expectedPanes =
      state.edge === "three"
        ? 3
        : ["split", "stacked"].includes(state.edge)
          ? 2
          : 1;
    await waitFor(
      () => evaluate(`(() => {
        const panes = [...document.querySelectorAll('.gyro-chat-surface')];
        return panes.length === ${expectedPanes} && panes.every(pane =>
          pane.querySelector('.gyro-composer-shell') &&
          (${state.scene !== "active-chat"} || (pane.classList.contains('is-thread') && pane.querySelector('.gyro-user-message-bubble')))
        );
      })()`),
      `${state.name} populated scene before measurement`,
    );
    snapshot[state.name] = await evaluate(measure(state.probes));
    if (!snapshot[state.name].surface || !snapshot[state.name].composer)
      throw new Error(`${state.name}: scene disappeared during measurement`);
    if (auditInvariants) {
      contracts[state.name] = await evaluate(
        `(${measureChatContract.toString()})()`,
      );
      contractFailures.push(
        ...checkChatContract(state.name, contracts[state.name]),
      );
    }
    if (inventory && !wroteInventory) {
      const data = await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('.gyro-chat-surface, .gyro-chat-surface *')];
        const prefix = /\\.gyro-(?:chat-|composer-|message|user-message-|response|run|change-|send-button|context-summary-|environment-)/;
        const classes = [...new Set(nodes.flatMap(n => (n.getAttribute('class') || '').split(/\\s+/)).filter(Boolean))].sort();
        const sheets = [...document.styleSheets].map(sheet => {
          const owner = sheet.ownerNode;
          const id = owner?.getAttribute('data-vite-dev-id') || sheet.href;
          if (!id) return null;
          const rules = [];
          const visit = entries => { for (const rule of entries) {
            if (rule.selectorText) {
              const selector = rule.selectorText;
              let matched = false;
              try { matched = nodes.some(n => n.matches(selector)); } catch {}
              if (matched && !prefix.test(selector)) rules.push({ selector, declarations: [...rule.style].map(property => ({ property, value: rule.style.getPropertyValue(property), important: rule.style.getPropertyPriority(property) === 'important' })) });
            }
            if (rule.cssRules) visit(rule.cssRules);
          }};
          visit(sheet.cssRules);
          return { id, ruleCount: sheet.cssRules.length, nonChatMatches: rules };
        }).filter(Boolean);
        return { sheets, classes };
      })()`);
      const directory = resolve(
        repoRoot,
        "artifacts/chat-consolidation/inventory",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        resolve(directory, `${argument("--inventory-name") ?? "dev"}.json`),
        JSON.stringify(data, null, 2),
      );
      wroteInventory = true;
    }
    if (saveShots) {
      const png = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        resolve(shotRoot, `${state.name}.png`),
        Buffer.from(png.data, "base64"),
      );
      const reference = resolve(pixelRoot, `${state.name}.png`);
      if (recordPixels) {
        mkdirSync(pixelRoot, { recursive: true });
        writeFileSync(reference, Buffer.from(png.data, "base64"));
      } else if (pixels) {
        if (!existsSync(reference))
          pixelFailures.push(`${state.name}: pixel baseline missing`);
        else if (
          !readFileSync(reference).equals(Buffer.from(png.data, "base64"))
        ) {
          const comparison = spawnSync(
            "python3",
            [
              resolve(repoRoot, "scripts/compare-render-pixels.py"),
              reference,
              resolve(shotRoot, `${state.name}.png`),
              resolve(shotRoot, `${state.name}-diff.png`),
            ],
            { encoding: "utf8" },
          );
          if (comparison.status !== 0)
            pixelFailures.push(
              `${state.name}: ${comparison.stdout.trim() || comparison.stderr.trim()}`,
            );
        }
      }
    }
    await send("Target.closeTarget", { targetId });
    console.log(`measured ${state.name}`);
  }
} finally {
  socket?.close();
  browser.kill();
  try {
    rmSync(profile, { force: true, recursive: true });
  } catch {
    // ignore
  }
}

if (auditInvariants) {
  const directory = resolve(repoRoot, "artifacts/chat-consolidation");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "render-contract.json"),
    JSON.stringify({ states: contracts, failures: contractFailures }, null, 2),
  );
  if (contractFailures.length) {
    console.error(contractFailures.join("\n"));
    process.exit(1);
  }
}
if (invariantsOnly) {
  console.log(`Chat design contracts passed (${states.length} states).`);
  process.exit(0);
}

if (update || recordBaseline) {
  // Filtered measurements may be saved as a separate review artifact, but
  // must never replace the complete repository baseline.
  if (
    filter &&
    (update || baselinePath === resolve(repoRoot, "scripts/chat-render-baseline.json"))
  )
    throw new Error("Refusing to write a partial baseline: unset the filter.");
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  throw new Error(
    "No baseline yet. Run with --update to record scripts/chat-render-baseline.json.",
  );
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const differences = [...pixelFailures];
for (const [stateName, probes] of Object.entries(snapshot)) {
  const expected = baseline[stateName];
  if (!expected) {
    differences.push(`${stateName}: not in the baseline`);
    continue;
  }
  for (const probe of new Set([
    ...Object.keys(expected),
    ...Object.keys(probes),
  ])) {
    const before = expected[probe];
    const after = probes[probe];
    if (!before || !after) {
      if (before !== after && (before || after))
        differences.push(
          `${stateName} ${probe}: ${before ? "no longer rendered" : "newly rendered"}`,
        );
      continue;
    }
    for (const key of Object.keys(before)) {
      if (before[key] !== after[key])
        differences.push(
          `${stateName} ${probe}.${key}: ${before[key]} -> ${after[key]}`,
        );
    }
  }
}
if (differences.length) {
  console.error(
    `Chat render differs from the baseline in ${differences.length} value(s):`,
  );
  for (const difference of differences) console.error(`  ${difference}`);
  console.error(
    "If the change is intended, rerun with --update and review the screenshots.",
  );
  process.exit(1);
}
console.log(
  `Chat render matches the baseline (${Object.keys(snapshot).length} states).`,
);
