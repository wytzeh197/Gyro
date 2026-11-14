import assert from "node:assert/strict";
import { RemoteHostClient } from "../apps/desktop/src/remote-access/client.ts";
import {
  emptyView,
  readView,
  persistView,
} from "../apps/desktop/src/remote-access/view-state.ts";

const calls = [],
  listeners = new Set();
let releaseInput;
let pendingInput = false;
let rejectInput = false;
const ports = {
  async invoke(command, args) {
    calls.push({ command, args });
    const operation = args?.request?.operation;
    if (operation?.op === "claim") return { owner: "client", generation: 17 };
    if (operation?.op === "terminal" && operation.action === "input") {
      if (rejectInput) throw Error("connection lost");
      if (pendingInput)
        await new Promise((resolve) => {
          releaseInput = resolve;
        });
    }
    return {};
  },
  async listen(_event, handler) {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
};
const a = new RemoteHostClient("host-a", ports);
const b = new RemoteHostClient("host-b", ports);
await a.request({ op: "claim", sessionId: "same-session-id" });
await a.request(
  { op: "stop", sessionId: "same-session-id" },
  "fixed-request-id",
);
await b.request({ op: "stop", sessionId: "same-session-id" });
const stops = calls.filter((c) => c.args?.request?.operation.op === "stop");
assert.equal(stops[0].args.hostId, "host-a");
assert.equal(stops[0].args.request.lease, 17);
assert.equal(stops[0].args.request.id, "fixed-request-id");
assert.equal(stops[1].args.hostId, "host-b");
assert.equal(stops[1].args.request.lease, undefined);

let observed = 0;
const unlisten = await a.subscribe("same-session-id", () => observed++);
const watch = calls.findLast((c) => c.command === "remote_host_watch").args
  .watchId;
for (const listener of listeners) {
  listener({
    payload: {
      hostId: "host-b",
      watchId: watch,
      event: { sessionId: "same-session-id", topic: "refresh" },
    },
  });
  listener({
    payload: {
      hostId: "host-a",
      watchId: "old-watch",
      event: { sessionId: "same-session-id", topic: "refresh" },
    },
  });
  listener({
    payload: {
      hostId: "host-a",
      watchId: watch,
      event: { sessionId: "different-session", topic: "refresh" },
    },
  });
  listener({
    payload: {
      hostId: "host-a",
      watchId: watch,
      event: { sessionId: "same-session-id", topic: "refresh" },
    },
  });
}
assert.equal(
  observed,
  1,
  "events stay scoped to host, session and subscription",
);
unlisten();

pendingInput = true;
const first = a.request({
  op: "terminal",
  action: "input",
  sessionId: "same-session-id",
  paneId: "p",
  input: "l",
});
const second = a.request({
  op: "terminal",
  action: "input",
  sessionId: "same-session-id",
  paneId: "p",
  input: "s",
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  calls.filter((c) => c.args?.request?.operation.action === "input").length,
  1,
  "second keystroke waits for the first",
);
pendingInput = false;
releaseInput();
await Promise.all([first, second]);
assert.deepEqual(
  calls
    .filter((c) => c.args?.request?.operation.action === "input")
    .map((c) => c.args.request.operation.input),
  ["l", "s"],
);

rejectInput = true;
const before = calls.length;
const failed = await Promise.allSettled([
  a.request({
    op: "terminal",
    action: "input",
    sessionId: "same-session-id",
    paneId: "p",
    input: "x",
  }),
  a.request({
    op: "terminal",
    action: "input",
    sessionId: "same-session-id",
    paneId: "p",
    input: "y",
  }),
]);
assert.ok(failed.every((result) => result.status === "rejected"));
assert.equal(
  calls
    .slice(before)
    .filter((c) => c.args?.request?.operation.action === "input").length,
  1,
  "queued keystrokes are not replayed after a connection failure",
);

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
};
values.set(
  "gyro.remote.view.corrupt",
  '{"panel":"wrong","buffers":{"x":1},"drafts":{"s":9},"pendingSubmissions":{"s":false}}',
);
assert.deepEqual(
  readView("corrupt", storage),
  emptyView(),
  "damaged state is bounded and sanitized",
);
const view = { ...emptyView(), drafts: { sameSession: "keep this draft" } };
const full = {
  getItem: () => null,
  setItem: () => {
    throw Error("quota");
  },
};
assert.equal(persistView("memory-a", view, full), false);
assert.equal(
  readView("memory-a", full).drafts.sameSession,
  "keep this draft",
  "a machine switch keeps drafts when disk storage is full",
);
assert.equal(
  readView("memory-b", full).drafts.sameSession,
  undefined,
  "the same session ID on another host has its own draft",
);

a.dispose();
b.dispose();
assert.equal(
  calls.findLast(
    (c) =>
      c.args?.hostId === "host-a" &&
      c.args?.request?.operation.op === "release",
  )?.args.request.lease,
  17,
  "view cleanup fences its release to the previous control generation",
);
await assert.rejects(a.request({ op: "projects" }), /closed/);
assert.ok(
  calls.every((call) =>
    ["remote_host_request", "remote_host_watch"].includes(call.command),
  ),
  "remote clients never invoke a local execution command",
);
assert.ok(
  !calls.some((call) => call.command === "stop_provider_chat"),
  "disconnect does not stop host work",
);
console.log(
  "Remote client checks passed: routing, leases, stale events, ordered input, uncertain input, draft isolation and storage recovery.",
);
