import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveBootSurface } from "../apps/desktop/src/surface-boundary.ts";
import {
  chatCompanionTabIds,
  chatCompanionReducer,
  createInitialChatCompanionState,
  activeChatCompanionPanel,
  resolveChatRailPanel,
} from "../packages/ui/src/chat-companion.ts";
import { createBrowserHostVisibility } from "../apps/desktop/src/browser-host-visibility.ts";

for (const surface of [null, "menu-bar", "unknown"]) {
  assert.equal(
    resolveBootSurface({ browserAgent: false, framed: false, surface }),
    surface === "menu-bar" ? "menu-bar" : "main",
  );
  for (const [browserAgent, framed] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    assert.equal(
      resolveBootSurface({ browserAgent, framed, surface }),
      "embedded",
    );
  }
}

// Execute the real entry point: embedded app pages must not import the
// workbench/menu bar, subscribe to app events, or restore persisted panels.
const source = readFileSync(
  new URL("../apps/desktop/src/main.tsx", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
for (const framed of [false, true]) {
  const imports = [];
  const renders = [];
  const window = {
    location: { search: "?surface=menu-bar" },
    matchMedia: () => ({ matches: false }),
  };
  window.self = window;
  window.top = framed ? {} : window;
  if (!framed) window.__gyroBrowserAgentInstalled = true;
  const document = {
    documentElement: { dataset: {} },
    querySelector: () => null,
    getElementById: () => ({}),
  };
  runInNewContext(js, {
    exports: {},
    window,
    document,
    URLSearchParams,
    console,
    localStorage: { getItem: () => null },
    require(name) {
      imports.push(name);
      if (name === "react")
        return {
          Component: class {},
          createElement: (tag, props, ...children) => ({
            tag,
            props,
            children,
          }),
        };
      if (name === "react-dom/client")
        return { createRoot: () => ({ render: (node) => renders.push(node) }) };
      if (name === "./surface-boundary") return { resolveBootSurface };
      if (name === "./early-shell" || name.endsWith(".css")) return {};
      throw new Error(`Embedded workbench imported ${name}`);
    },
  });
  await Promise.resolve();
  assert.equal(document.documentElement.dataset.surface, "embedded");
  assert.equal(renders.length, 1);
  assert.equal(renders[0].props.className, "gyro-embedded-boundary");
  assert.ok(
    !imports.includes("./App") && !imports.includes("./MenuBarPopover"),
  );
}

// Every ordered pair of tools, across two independent chat panes.
for (const from of chatCompanionTabIds) {
  for (const to of chatCompanionTabIds) {
    let state = createInitialChatCompanionState();
    for (const action of [
      { type: "open-tab", paneId: "other", tab: from },
      { type: "open-tab", paneId: "current", tab: from },
      { type: "open-tab", paneId: "current", tab: to },
    ])
      state = chatCompanionReducer(state, action);
    assert.equal(activeChatCompanionPanel(state, "current"), to);
    assert.equal(activeChatCompanionPanel(state, "other"), from);
    assert.equal(
      resolveChatRailPanel({
        companionPanel: activeChatCompanionPanel(state),
        isEnvironmentVisible: false,
      }),
      to,
    );
    state = chatCompanionReducer(state, {
      type: "close-tab",
      paneId: "current",
      tab: to,
    });
    assert.equal(activeChatCompanionPanel(state, "other"), from);
    assert.equal(
      activeChatCompanionPanel(state, "current"),
      from === to ? "tools" : from,
    );
    const calls = [];
    const update = createBrowserHostVisibility(async (command, args) =>
      calls.push({ command, ...args }),
    );
    const bounds = { x: 0, y: 0, width: 400, height: 600 };
    await update("current", from === "browser" ? bounds : null);
    await update("current", to === "browser" ? bounds : null);
    assert.equal(calls.at(-1).visible, to === "browser");
  }
}
console.log(
  "Surface boundaries: embedded boot blocked; all 36 tool transitions and cross-chat isolation passed",
);
