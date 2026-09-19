import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Execute the actual composer action with deferred native calls to exercise
// the race between compaction and the next user action.
const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
const start = source.indexOf('case "compact-context": {');
const end = source.indexOf('case "open-terminal-panel":', start);
const action = ts.transpileModule(
  `function run() { switch ("compact-context") { ${source.slice(start, end)} } }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

for (const outcome of ["success", "failure", "cancelled", "append-failure"]) {
  const busy = new Set();
  const statuses = [];
  const calls = [];
  let finish;
  const pending = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const context = {
    activeSessionId: "chat", activeSession: { providerId: "openai" },
    sendingSessionIdsRef: { current: busy },
    notify() {}, isTauriRuntime: () => true,
    crypto: { randomUUID: () => "compact-turn" }, config: {},
    setSessionSending: (id, sending) => sending ? busy.add(id) : busy.delete(id),
    createOptimisticTurnEvents: () => [], providersForConfig: () => [],
    optimisticEventsRef: { current: new Map() },
    mergePersistedAndOptimisticEvents: (a, b) => [...a, ...b],
    setEventsForSession() {},
    updateOptimisticProviderStatus: (_ref, _set, _id, _turn, status) => statuses.push(status),
    isProviderStop: (error) => error.includes("chat cancelled by"),
    refreshEvents: async () => {},
    invoke: async (command) => {
      calls.push(command);
      if (outcome === "append-failure" && command === "append_user_message") throw Error("write failed");
      if (command === "compact_provider_chat") return pending;
    },
  };
  const run = new Function(...Object.keys(context), `${action}; return run;`)(...Object.values(context));
  run();
  assert(busy.has("chat"), "busy must be set before the first native await");
  run();
  assert.equal(calls.filter((c) => c === "append_user_message").length, 1, "a second compaction cannot race the first");
  await new Promise(setImmediate);
  if (outcome === "success") finish.resolve({});
  else if (outcome !== "append-failure") finish.reject(Error(outcome === "cancelled" ? "chat cancelled by user" : "compaction failed"));
  await new Promise(setImmediate);
  assert(!busy.has("chat"), "every terminal outcome must release the send slot");
  assert.equal(statuses.at(-1), outcome === "success" ? "done" : outcome === "cancelled" ? "cancelled" : "failed");
}
console.log("Context compaction lifecycle: 4 outcomes passed");
