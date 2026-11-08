// Execute shipped hooks with controlled visibility, immutable config updates,
// and cached native readings. Counts are work measurements, not CPU estimates.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const flush = () => new Promise(setImmediate);
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function harness(baseline) {
  const slots = [], effects = [], timers = new Map(), listeners = new Map();
  let slot = 0, nextTimer = 0, stateChanges = 0;
  const react = {
    useRef(initial) { return slots[slot++] ??= { current: initial }; },
    useMemo(fn, deps) {
      const id = slot++;
      if (!same(slots[id]?.deps, deps)) slots[id] = { deps, value: fn() };
      return slots[id].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useState(initial) {
      const id = slot++;
      slots[id] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[id].value, update => {
        const value = typeof update === "function" ? update(slots[id].value) : update;
        if (!Object.is(value, slots[id].value)) stateChanges++;
        slots[id].value = value;
      }];
    },
    useEffect(fn, deps) {
      const id = slot++;
      if (!same(slots[id]?.deps, deps)) effects.push(() => {
        slots[id]?.cleanup?.();
        slots[id] = { deps, cleanup: fn() };
      });
    },
  };
  const environment = { focused: true, visible: "visible" };
  function events(target) {
    return {
      addEventListener(name, fn) {
        const key = `${target}:${name}`;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
      },
      removeEventListener(name, fn) { listeners.get(`${target}:${name}`)?.delete(fn); },
    };
  }
  const window = {
    __TAURI_INTERNALS__: {}, ...events("window"),
    setInterval(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval(id) { timers.delete(id); },
  };
  const document = {
    ...events("document"),
    get visibilityState() { return environment.visible; },
    hasFocus: () => environment.focused,
  };
  const modules = new Map();
  function load(file, dependencies = {}) {
    if (modules.has(file)) return modules.get(file);
    const source = baseline
      ? execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" })
      : readFileSync(new URL(file, root), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    runInNewContext(js, {
      exports, window, document, navigator: { onLine: true }, queueMicrotask,
      require(id) {
        if (id === "react") return react;
        if (id in dependencies) return dependencies[id];
        throw Error(`Unexpected dependency ${id} in ${file}`);
      },
    });
    modules.set(file, exports);
    return exports;
  }
  return {
    load, timers, environment,
    render(fn) { slot = 0; const result = fn(); while (effects.length) effects.shift()(); return result; },
    event(target, name) { for (const fn of listeners.get(`${target}:${name}`) ?? []) fn(); },
    tick() { for (const { fn } of [...timers.values()]) fn(); },
    stateChanges: () => stateChanges,
    cleanup() { for (const value of slots) value?.cleanup?.(); },
  };
}

async function measure(baseline) {
  const usage = harness(baseline);
  const reading = { providerId: "openai", fetchedAt: "2026-11-08T12:00:00Z", windows: [{ id: "weekly", label: "Weekly", usedPercent: 42 }] };
  const state = usage.load("apps/desktop/src/provider-usage-state.ts");
  let calls = 0, ledger = 0;
  const { useProviderUsage } = usage.load("apps/desktop/src/use-provider-usage.ts", {
    "@tauri-apps/api/core": { invoke: async () => { calls++; return structuredClone(reading); } },
    "@tauri-apps/api/event": { listen: async () => () => {} },
    "@gyro-dev/ui": { providerSupportsUsage: () => true },
    "./provider-usage-state": state,
  });
  const notify = () => {};
  const refreshProviderLedger = async () => { ledger++; };
  let api;
  for (let index = 0; index < 20; index++) {
    api = usage.render(() => useProviderUsage({ notify, refreshProviderLedger, backgroundUsageProviderIds: ["openai"], backgroundLedgerProviderIds: ["openai"] }));
    await flush();
  }
  const configCalls = calls;
  const startChanges = usage.stateChanges();
  usage.tick();
  await flush();
  const cachedReadingStateChanges = usage.stateChanges() - startChanges;
  usage.environment.focused = false;
  const beforeBackground = calls;
  for (let tick = 0; tick < 60; tick++) { usage.tick(); await flush(); }
  const unfocusedCalls = calls - beforeBackground;
  const beforeExplicit = calls;
  await api.refreshProviderUsage("openai", false, true);
  assert.equal(calls - beforeExplicit, 1, "Explicit post-turn reads must work while unfocused");
  usage.environment.focused = true;
  const beforeFocus = calls;
  usage.event("window", "focus");
  await flush();
  assert.equal(calls - beforeFocus, 1, "Focus must refresh immediately");
  usage.cleanup();
  assert.equal(usage.timers.size, 0);

  const explorer = harness(baseline);
  const { useWorkspaceExplorerFiles } = explorer.load("apps/desktop/src/workspace-explorer.ts", {
    "@gyro-dev/ui/workspace-project": { workspaceExplorerRootEntryGroup: () => "source" },
  });
  explorer.render(() => useWorkspaceExplorerFiles([], async () => [], notify));
  const collapsedExplorerTimers = explorer.timers.size;
  explorer.cleanup();

  const language = harness(baseline);
  let disposals = 0, diagnosticPolls = 0;
  const { useLanguageSessions } = language.load("apps/desktop/src/editor/use-language-sessions.ts", {
    "@tauri-apps/api/core": {},
    "@gyro-dev/ui": {
      workspaceRootForPath: roots => roots[0], isWorkspaceTrusted: () => true,
      editorFilePolicy: () => ({ binary: false, limited: false }),
      resolveLanguage: () => ({ id: "typescript", lsp: { command: "fixture-lsp" } }),
    },
    "../tauri-runtime": { isTauriRuntime: () => true },
    "./language-sessions": { LanguageSessions: class {
      async reconcile() {} async dispose() { disposals++; } async poll() { diagnosticPolls++; }
    } },
  });
  const languageOptions = { roots: [], buffers: {}, languageOverrides: {}, trust: {}, onState: notify, onMessages: notify };
  language.render(() => useLanguageSessions(languageOptions));
  const emptyEditorTimers = language.timers.size;
  language.render(() => useLanguageSessions({ ...languageOptions, roots: ["/fixture"], buffers: { "/fixture/a.ts": { content: "const a = 1;", sizeBytes: 12 } } }));
  assert.equal(language.timers.size, 1, "An eligible editor must retain diagnostic polling");
  language.tick();
  assert.equal(diagnosticPolls, 1);
  language.environment.visible = "hidden";
  language.tick();
  assert.equal(diagnosticPolls, 1, "Hidden windows must not poll diagnostics");
  language.environment.visible = "visible";
  language.event("document", "visibilitychange");
  if (!baseline) assert.equal(diagnosticPolls, 2, "Visibility restores current diagnostics immediately");
  language.render(() => useLanguageSessions(languageOptions));
  assert.equal(disposals, 0, "Removing a timer must not prematurely dispose the shared manager");
  if (!baseline) assert.equal(language.timers.size, 0);
  language.cleanup();
  await flush();
  assert.equal(disposals, 1, "Unmount still releases the language manager");

  const sessions = harness(baseline);
  const { LanguageSessions } = sessions.load("apps/desktop/src/editor/language-sessions.ts", {
    "./document-uri": { canonicalFileUri: path => `file://${path}` },
  });
  const pendingPolls = [];
  const manager = new LanguageSessions({
    transport: {
      start: async doc => ({ serverId: doc.root, message: "ready" }),
      send: async (_id, method) => method === "$/gyro/poll"
        ? new Promise(resolve => pendingPolls.push(resolve)) : { status: "sent" },
      stop: async () => {},
    },
    onState: notify, onMessages: notify,
  });
  await manager.reconcile(["/first", "/second"].map(root => ({
    root, path: `${root}/a.ts`, languageId: "typescript", command: "fixture-lsp", content: "fixture",
  })));
  const polls = Array.from({ length: 60 }, () => manager.poll());
  await flush();
  const slowLanguagePollRequests = pendingPolls.length;
  pendingPolls.forEach(resolve => resolve({ status: "ok" }));
  await Promise.all(polls);
  await manager.dispose();
  return { configCalls, cachedReadingStateChanges, unfocusedCalls, collapsedExplorerTimers, emptyEditorTimers, slowLanguagePollRequests };
}

const after = await measure();
assert.deepEqual(after, { configCalls: 1, cachedReadingStateChanges: 0, unfocusedCalls: 0, collapsedExplorerTimers: 0, emptyEditorTimers: 0, slowLanguagePollRequests: 2 });
const baselineIndex = process.argv.indexOf("--baseline");
const baseline = baselineIndex < 0 ? undefined : process.argv[baselineIndex + 1];
const result = {
  schema: "gyro.resource-scheduling.v1", evidence: "Actual hook execution with controlled clocks and stub native transports; not a native CPU or RAM measurement",
  ...(baseline ? { baseline, before: await measure(baseline) } : {}), after,
};
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
