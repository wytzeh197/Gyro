import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const transpile = (path) =>
  ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const boot = transpile("../apps/desktop/src/main.tsx");
const element = (type, props, ...children) => ({
  type,
  props: { ...props, children },
});
const react = {
  createElement: element,
  Component: class {},
  StrictMode: "strict",
};

async function runBoot(surface, failure) {
  const renders = [];
  let reloads = 0;
  const window = {
    self: {},
    location: { search: "", reload: () => reloads++ },
    matchMedia: () => ({ matches: false }),
  };
  window.top = window.self;
  runInNewContext(boot, {
    exports: {},
    URLSearchParams,
    console: { error() {} },
    window,
    localStorage: { getItem: () => null },
    document: {
      documentElement: { dataset: {} },
      querySelector: () => null,
      getElementById: () => ({}),
    },
    require: (id) => {
      if (id === "react") return { default: react };
      if (id === "react-dom/client")
        return {
          default: {
            createRoot: () => ({ render: (tree) => renders.push(tree) }),
          },
        };
      if (id === "./surface-boundary")
        return { resolveBootSurface: () => surface };
      if (id === "./early-shell") return { EarlyShell: "early-shell" };
      if (id === failure) throw new Error("failed module");
      if (id === "./App") return { App: "app" };
      if (id === "./MenuBarPopover") return { MenuBarPopover: "menu" };
      if (id.endsWith(".css")) return {};
      throw new Error("Unexpected import " + id);
    },
  });
  await flush();
  return { renders, reloads: () => reloads };
}
for (const [surface, module] of [
  ["main", "./App"],
  ["menu-bar", "./MenuBarPopover"],
]) {
  for (const failed of [module, "@gyro-dev/ui/styles.css"]) {
    const result = await runBoot(surface, failed);
    const fallback = result.renders.at(-1);
    assert.equal(
      fallback.props.startup,
      true,
      "module/CSS failure must replace the loading shell",
    );
    const tree = fallback.type(fallback.props);
    assert.equal(tree.props.role, "alert");
    assert.equal(
      result.reloads(),
      0,
      "recovery must not trigger an automatic reload loop",
    );
    const button = tree.props.children.find((node) => node.type === "button");
    button.props.onClick();
    assert.equal(result.reloads(), 1);
  }
  const success = await runBoot(surface);
  const boundaryElement = success.renders.at(-1).props.children[0];
  const Boundary = boundaryElement.type;
  const boundary = new Boundary();
  boundary.props = boundaryElement.props;
  assert.equal(boundary.render()[0].type, surface === "main" ? "app" : "menu");
  for (const thrown of [new Error("render failed"), null, "bad render"]) {
    boundary.state = Boundary.getDerivedStateFromError(thrown);
    assert.equal(boundary.render().type({}).props.role, "alert");
  }
}

const usage = transpile("../apps/desktop/src/use-provider-usage.ts");
let effect;
let cleanup;
let timer;
let state = {};
const listeners = new Map();
let usageCalls = 0;
let ledgerCalls = 0;
const document = {
  visibilityState: "visible",
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: (name) => listeners.delete(name),
};
const navigator = { onLine: true };
const window = {
  __TAURI_INTERNALS__: {},
  setInterval: (fn) => {
    timer = fn;
    return 1;
  },
  clearInterval: () => {
    timer = undefined;
  },
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: (name) => listeners.delete(name),
};
const exports = {};
runInNewContext(usage, {
  exports,
  window,
  document,
  navigator,
  require: (id) => {
    if (id === "react")
      return {
        useCallback: (fn) => fn,
        useEffect: (fn) => {
          effect = fn;
        },
        useRef: (current) => ({ current }),
        useState: () => [
          state,
          (fn) => {
            state = fn(state);
          },
        ],
      };
    if (id === "@tauri-apps/api/core")
      return {
        invoke: async () => {
          usageCalls++;
          return {};
        },
      };
    if (id === "@gyro-dev/ui") return { providerSupportsUsage: () => true };
    if (id === "./provider-usage-state")
      return {
        providerUsageFromSnapshot: () => ({ windows: [] }),
        providerUsageAfterError: () => ({ windows: [] }),
      };
    throw new Error("Unexpected import " + id);
  },
});
const { refreshProviderUsage } = exports.useProviderUsage({
  notify() {},
  backgroundUsageProviderIds: ["openai"],
  backgroundLedgerProviderIds: ["openai"],
  refreshProviderLedger: async () => {
    ledgerCalls++;
  },
});
cleanup = effect();
await flush();
assert.equal(usageCalls, 1);
assert.equal(ledgerCalls, 1);
document.visibilityState = "hidden";
for (let i = 0; i < 80; i++) timer();
listeners.get("online")();
await flush();
assert.equal(
  usageCalls,
  1,
  "one hidden hour must perform zero additional usage polls",
);
assert.equal(ledgerCalls, 1);
document.visibilityState = "visible";
navigator.onLine = false;
timer();
listeners.get("focus")();
await flush();
assert.equal(
  usageCalls,
  1,
  "offline background events must not start requests",
);
navigator.onLine = true;
listeners.get("online")();
await flush();
assert.equal(usageCalls, 2, "reconnecting must refresh usage");
assert.equal(ledgerCalls, 2);
document.visibilityState = "hidden";
await refreshProviderUsage("openai");
assert.equal(usageCalls, 3, "explicit refresh stays available");
document.visibilityState = "visible";
listeners.get("visibilitychange")();
await flush();
assert.equal(usageCalls, 4, "returning to the app must refresh usage");
cleanup();
assert.equal(timer, undefined);
assert.equal(listeners.size, 0);
console.log(
  "Page reliability passed: startup/render recovery, explicit reload, polling suspension and resume, listener cleanup.",
);
