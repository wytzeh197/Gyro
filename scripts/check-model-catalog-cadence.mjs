import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Drives the real catalog scheduler against a controlled clock and document, so
// "a published addition reaches a watching picker in minutes" is verified here
// rather than asserted in a comment. No wall-clock waiting and no renderer.
const source = readFileSync(
  new URL("../apps/desktop/src/use-model-catalog.ts", import.meta.url),
  "utf8",
);
const snippet = source
  .slice(source.indexOf("/** Announce an addition"))
  .replace(/^export function /gm, "function ");
assert.ok(
  snippet.includes("function useModelCatalog("),
  "Cadence fixture must exercise the real hook source",
);

const focusedPollMs = 60_000;
const backgroundPollMs = 6 * 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

let timerId = 0;
const timers = new Map();
const listeners = new Map();
const refreshes = [];
const effects = [];
const recorded = { configs: 0, normalizations: 0, notifications: [] };
let nextRefresh = { applied: false, additions: [] };
let focused = true;

const documentStub = {
  visibilityState: "visible",
  hasFocus: () => focused,
  addEventListener(type, listener) {
    listeners.set("document:" + type, listener);
  },
  removeEventListener(type, listener) {
    if (listeners.get("document:" + type) === listener) {
      listeners.delete("document:" + type);
    }
  },
};
const windowStub = {
  setTimeout(listener, delay) {
    const id = (timerId += 1);
    timers.set(id, { listener, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  addEventListener(type, listener) {
    listeners.set("window:" + type, listener);
  },
  removeEventListener(type, listener) {
    if (listeners.get("window:" + type) === listener) {
      listeners.delete("window:" + type);
    }
  },
};
const client = {
  async refresh() {
    const result = nextRefresh;
    nextRefresh = { applied: false, additions: [] };
    refreshes.push(result);
    return result;
  },
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  client,
  isTauri: () => true,
  MODEL_CATALOG_POLL_MS: focusedPollMs,
  MODEL_CATALOG_REFRESH_MS: backgroundPollMs,
  useEffect: (effect) => effects.push(effect),
};
runInNewContext(
  ts.transpileModule(`${snippet}\nglobalThis.catalogHook = useModelCatalog;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  sandbox,
);

/** Run whatever the scheduler queued next, as the browser would. */
const fireTimer = async () => {
  const [entry] = timers.entries();
  assert.equal(timers.size, 1, "exactly one check may be pending");
  const [id, timer] = entry;
  timers.delete(id);
  timer.listener();
  await flush();
};
/** The delay the scheduler chose for the check it is now waiting on. */
const pendingDelay = () => {
  assert.equal(timers.size, 1, "exactly one check may be pending");
  return timers.values().next().value.delay;
};
const fire = async (key) => {
  assert.ok(listeners.has(key), `no listener registered for ${key}`);
  listeners.get(key)();
  await flush();
};

sandbox.catalogHook(
  false,
  (update) => {
    recorded.configs += 1;
    update({ modelProviders: [] });
  },
  (config) => {
    recorded.normalizations += 1;
    return config;
  },
  (kind, title, detail) => recorded.notifications.push({ kind, title, detail }),
);
assert.equal(effects.length, 1, "mounting registers one refresh effect");
const cleanup = effects[0]();

// A focused, visible window is the case that has to feel immediate.
await flush();
assert.equal(refreshes.length, 1, "the hook checks once as the shell loads");
assert.equal(pendingDelay(), focusedPollMs);
await fireTimer();
assert.equal(
  pendingDelay(),
  focusedPollMs,
  "a focused window keeps the fast cadence",
);

nextRefresh = {
  applied: true,
  additions: [
    {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
    },
  ],
};
await fireTimer();
assert.deepEqual(recorded.notifications, [
  {
    kind: "provider",
    title: "New model available",
    detail: "Claude Opus 5.5 (Anthropic) is now available in the model picker.",
  },
]);
assert.equal(
  recorded.configs,
  1,
  "an applied document re-normalizes the config",
);
assert.equal(recorded.normalizations, 1);

nextRefresh = {
  applied: true,
  additions: [
    {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
    },
    {
      providerId: "openai",
      providerLabel: "OpenAI",
      id: "gpt-6",
      displayName: "GPT-6",
    },
  ],
};
await fireTimer();
assert.equal(recorded.notifications.at(-1).title, "2 new models available");
assert.equal(
  recorded.notifications.at(-1).detail,
  "Claude Opus 5.5 (Anthropic), GPT-6 (OpenAI) are now available in the model picker.",
);

// Coming back to the window checks at once instead of waiting out the interval.
const before = refreshes.length;
await fire("window:focus");
assert.equal(
  refreshes.length,
  before + 1,
  "regaining focus checks immediately",
);
assert.equal(pendingDelay(), focusedPollMs);
await fire("window:online");
assert.equal(
  refreshes.length,
  before + 2,
  "coming back online checks immediately",
);

// An unwatched app falls back to the slow cadence, and hiding the window is not
// itself a reason to spend a request.
documentStub.visibilityState = "hidden";
const hidden = refreshes.length;
await fire("document:visibilitychange");
assert.equal(
  refreshes.length,
  hidden,
  "becoming hidden does not start a check",
);
await fireTimer();
assert.equal(
  pendingDelay(),
  backgroundPollMs,
  "hiding the window falls back to the slow cadence",
);
documentStub.visibilityState = "visible";
focused = false;
await fireTimer();
assert.equal(
  pendingDelay(),
  backgroundPollMs,
  "an unfocused window is not watched",
);
// A focus event means the window is frontmost again, so the fixture moves both
// signals the scheduler reads.
focused = true;
await fire("window:focus");
assert.equal(pendingDelay(), focusedPollMs, "focus restores the fast cadence");
focused = false;
await fireTimer();
assert.equal(
  pendingDelay(),
  backgroundPollMs,
  "an unfocused window returns to the slow cadence",
);

// Teardown leaves nothing pending, nothing listening, and nothing to refresh
// even if a listener outlives the hook.
const leaked = listeners.get("window:focus");
const settled = refreshes.length;
cleanup();
assert.equal(timers.size, 0, "cleanup must clear the pending check");
assert.equal(listeners.size, 0, "cleanup must remove every listener");
leaked();
await flush();
assert.equal(
  refreshes.length,
  settled,
  "a discarded hook must not check again",
);

console.log(
  "Model catalog cadence checks passed: focused polling, background fallback, focus and online catch-up, addition announcements, and teardown.",
);
