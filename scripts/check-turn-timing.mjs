import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(
  new URL("../apps/desktop/src/turn-timing.ts", import.meta.url),
  "utf8",
);
function harness(optIn) {
  let time = 0;
  const saved = [],
    frames = [];
  const context = {
    exports: {},
    require: () => ({
      invoke: async (command, args) => {
        if (command === "timing_diagnostics_enabled") return optIn;
        if (command === "record_frontend_timing") {
          saved.push(args.value);
          return;
        }
        if (command === "fail") throw new Error("private provider error");
        return { done: true };
      },
    }),
    window: { __TAURI_INTERNALS__: {} },
    document: { visibilityState: "visible" },
    performance: { now: () => time },
    console,
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return {
    api: context.exports,
    saved,
    context,
    at: (value) => {
      time = value;
    },
    paint: () => {
      for (let i = 0; i < 2; i++) frames.splice(0).forEach((fn) => fn());
    },
  };
}
const off = harness(false);
await off.api.initializeTurnTiming();
off.api.beginTurnTiming("off");
await off.api.invokeTimedProviderChat("run_provider_chat", {
  request: { turnId: "off" },
});
assert.equal(off.saved.length, 0, "opt-out never records");
const h = harness(true);
await h.api.initializeTurnTiming();
h.api.beginTurnTiming("turn");
h.at(25);
const call = h.api.invokeTimedProviderChat("run_provider_chat", {
  request: { turnId: "turn" },
});
h.at(80);
h.api.receiveTurnTiming({
  turnId: "turn",
  phase: "heartbeat",
  message: "private heartbeat",
});
h.api.committedTurnTiming([
  { turnId: "turn", payload: { kind: "provider-status" } },
]);
h.paint();
assert.equal(h.saved.length, 0, "heartbeat is not progress");
h.at(100);
h.api.receiveTurnTiming({
  turnId: "turn",
  phase: "delta",
  textDelta: "PRIVATE OUTPUT",
});
h.api.committedTurnTiming([
  { turnId: "turn", payload: { kind: "provider-stream" } },
]);
h.at(132);
h.paint();
await call;
assert.equal(h.saved[0].sendToInvokeMs, 25);
assert.equal(h.saved[0].sendToReceivedMs, 100);
assert.equal(h.saved[0].receivedToPaintMs, 32);
assert.ok(!JSON.stringify(h.saved).includes("PRIVATE"));
const failed = harness(true);
await failed.api.initializeTurnTiming();
failed.api.beginTurnTiming("failed");
await assert.rejects(
  failed.api.invokeTimedProviderChat("fail", { request: { turnId: "failed" } }),
);
assert.equal(failed.saved.length, 1, "failed RPC still records duration");
const hidden = harness(true);
await hidden.api.initializeTurnTiming();
hidden.api.beginTurnTiming("hidden");
hidden.api.receiveTurnTiming({
  turnId: "hidden",
  phase: "delta",
  textDelta: "x",
});
hidden.context.document.visibilityState = "hidden";
hidden.api.committedTurnTiming([
  { turnId: "hidden", payload: { kind: "provider-stream" } },
]);
hidden.paint();
assert.equal(hidden.saved.length, 0, "hidden documents do not claim a paint");
console.log(
  "Turn timing: opt-out, failed sends, heartbeat exclusion, committed paint, and content exclusion passed.",
);
