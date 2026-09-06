import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual hooks with controlled slow RPCs. This tests scheduling
// behavior without relying on wall-clock timing or a particular laptop.
const source = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
function hook(name, next, context) {
  const start = source.indexOf(`  const ${name} = useCallback`);
  const end = source.indexOf(`  const ${next} = useCallback`, start);
  assert.ok(start > 0 && end > start);
  const js = ts.transpileModule(
    `${source.slice(start, end)}\nglobalThis.result = ${name};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const sandbox = {
    useCallback: (fn) => fn,
    isTauriRuntime: () => true,
    ...context,
  };
  runInNewContext(js, sandbox);
  return sandbox.result;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
let pending = [];
const events = [];
const refresh = hook("refreshIdeSourceControl", "refreshWorkspaceBranches", {
  ideSourceControlRequestRef: { current: 0 },
  ideSourceControlInFlightRef: { current: new Set() },
  ideSourceControlQueuedRef: { current: new Set() },
  dispatchWorkbench: (event) => events.push(event),
  invoke: (_command, args) =>
    new Promise((resolve, reject) => pending.push({ resolve, reject, args })),
});
for (let i = 0; i < 100; i++) refresh("/workspace/a");
assert.equal(
  pending.length,
  1,
  "refresh bursts must have only one Git RPC in flight",
);
pending.shift().resolve({ branch: "first" });
await flush();
assert.equal(
  pending.length,
  1,
  "a burst queues exactly one follow-up to catch mutations",
);
pending.shift().resolve({ branch: "fresh" });
await flush();
assert.equal(pending.length, 0);
assert.equal(events.at(-1).sourceControl.branch, "fresh");
refresh("/workspace/a");
refresh("/workspace/b");
pending.shift().resolve({ branch: "stale" });
await flush();
assert.equal(
  events.at(-1).sourceControl.branch,
  "fresh",
  "previous workspace results stay hidden",
);
pending.shift().reject(new Error("unavailable"));
await flush();
refresh("/workspace/b");
assert.equal(pending.length, 1, "failed RPCs release the in-flight guard");
pending.shift().resolve({ branch: "recovered" });
await flush();

let config;
let finishDiscovery;
const refreshConfig = hook("refreshConfig", "selectDestination", {
  setConfig: (value) => {
    config = typeof value === "function" ? value(config) : value;
  },
  setActiveProfileId: () => {},
  providersForConfig: (value) => value.modelProviders,
  withCouncilConfig: (value) => value,
  invoke: (command) =>
    command === "load_config"
      ? Promise.resolve({
          commandProfiles: [{ id: "shell" }],
          modelProviders: [{ id: "ollama", baseUrl: null, enabled: true }],
          preference: "original",
        })
      : new Promise((resolve) => {
          finishDiscovery = resolve;
        }),
});
await refreshConfig();
assert.equal(
  config.preference,
  "original",
  "workspace config loads before slow local discovery",
);
config = { ...config, preference: "edited while loading" };
finishDiscovery({
  baseUrl: "http://localhost:11434/api",
  models: [{ id: "test:small", displayName: "Test", supportsTools: false }],
});
await flush();
assert.equal(
  config.preference,
  "edited while loading",
  "discovery must preserve newer preferences",
);
assert.equal(config.modelProviders[0].selectedModelId, "test:small");
console.log(
  "Startup performance checks passed: bounded Git refresh bursts, stale-workspace suppression, failure recovery, nonblocking Ollama discovery, preserved preferences.",
);

const selectionStart = source.indexOf(
  '      if (action.startsWith("select-provider-model:"))',
);
const selectionEnd = source.indexOf(
  '      if (action.startsWith("select-provider-effort:"))',
  selectionStart,
);
assert.ok(selectionStart > 0 && selectionEnd > selectionStart);
for (const modelId of ["qwen3:0.6b", "namespace/model:tag", "gpt-5.6-sol"]) {
  let selected;
  runInNewContext(
    `(() => { ${source.slice(selectionStart, selectionEnd)} })()`,
    {
      action: `select-provider-model:ollama:${modelId}`,
      isProviderId: (id) => id === "ollama",
      selectProviderModel: (provider, model) => {
        selected = [provider, model];
      },
    },
  );
  assert.deepEqual(
    selected,
    ["ollama", modelId],
    "model menu actions preserve tags and namespaces",
  );
}
console.log(
  "Local-model menu checks passed: tags and namespaces reach provider selection intact.",
);
