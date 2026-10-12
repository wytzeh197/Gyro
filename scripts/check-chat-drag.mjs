import assert from "node:assert/strict";
import {
  beginChatSessionDrag,
  beginChatPaneDrag,
  currentChatDrag,
  currentChatSessionDrag,
  endChatDrag,
  endChatDragForTransfer,
  endChatSessionDrag,
  readChatDrag,
  readChatSessionDrag,
  subscribeChatDrag,
  chatDragSource,
  CHAT_SESSION_DRAG_MIME,
  CHAT_PANE_DRAG_MIME,
} from "../packages/ui/src/chat-session-drag.ts";
import {
  chatGridDropZones,
  chatGridDropZoneBeforePaint,
} from "../packages/ui/src/chat-grid-drop.ts";

// A fresh fixture makes the native lifecycle observable without a renderer.
globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
Object.defineProperty(document, "visibilityState", {
  value: "visible",
  writable: true,
});
const nativeEvent = (type, transfer, properties = {}) => {
  const event = new Event(type);
  Object.assign(event, { dataTransfer: transfer, ...properties });
  window.dispatchEvent(event);
};
const transfer = (data = {}, types = Object.keys(data), extra = {}) =>
  Object.defineProperties(
    {
      types,
      getData: (type) => data[type] ?? "",
    },
    Object.getOwnPropertyDescriptors(extra),
  );
const nativeSession = (payload) =>
  transfer({ [CHAT_SESSION_DRAG_MIME]: JSON.stringify(payload) });
const payload = { sessionId: "beta", projectKey: "/fixture/Gyro" };
const inaccessible = {
  getData() {
    throw new Error("Protected data store");
  },
};
const protectedTransfer = transfer();
const notifications = [];
const unsubscribe = subscribeChatDrag((drag) => notifications.push(drag));
assert.deepEqual(
  notifications,
  [undefined],
  "subscribers receive initial lifecycle state",
);

const sourcePayload = { ...payload };
const firstDrag = beginChatSessionDrag(sourcePayload);
sourcePayload.sessionId = "mutated";
assert.deepEqual(
  currentChatSessionDrag(),
  payload,
  "source mutations do not change drag identity",
);
assert.ok(Object.isFrozen(currentChatDrag()));
assert.deepEqual(
  readChatSessionDrag(inaccessible),
  payload,
  "internal identity survives unreadable native bytes",
);
assert.deepEqual(
  readChatSessionDrag(protectedTransfer),
  payload,
  "WebKit can hide types and bytes together",
);
assert.equal(chatDragSource(inaccessible), "session");
endChatSessionDrag("other");
assert.deepEqual(
  currentChatSessionDrag(),
  payload,
  "a different row's dragend must not clear this drag",
);
endChatSessionDrag("beta");
assert.equal(currentChatDrag(), undefined);
assert.equal(readChatDrag(inaccessible), undefined);
assert.deepEqual(
  readChatSessionDrag(nativeSession(payload)),
  payload,
  "external native session data is parsed for authoritative app validation",
);
assert.deepEqual(
  readChatSessionDrag(
    nativeSession({
      sessionId: '"'.repeat(512),
      projectKey: "\\".repeat(16_384),
    }),
  ),
  { sessionId: '"'.repeat(512), projectKey: "\\".repeat(16_384) },
  "JSON escaping does not reject payloads within the identity limits",
);

for (const raw of [
  "bad json",
  "null",
  "[]",
  '{"sessionId":7,"projectKey":""}',
  '{"sessionId":"","projectKey":""}',
  '{"sessionId":"   ","projectKey":""}',
  '{"sessionId":"x"}',
  '{"sessionId":"x","projectKey":7}',
  JSON.stringify({ sessionId: "x\n", projectKey: "" }),
  JSON.stringify({ sessionId: "x", projectKey: "p\u0000" }),
  JSON.stringify({ sessionId: "x".repeat(513), projectKey: "" }),
  JSON.stringify({ sessionId: "x", projectKey: "p".repeat(16_385) }),
]) {
  const malformed = transfer({ [CHAT_SESSION_DRAG_MIME]: raw });
  assert.equal(
    readChatDrag(malformed),
    undefined,
    "malformed session data is rejected",
  );
  assert.equal(
    chatDragSource(malformed),
    "session",
    "malformed chat MIME is still intercepted before text insertion",
  );
  beginChatSessionDrag(payload);
  assert.equal(
    readChatDrag(malformed),
    undefined,
    "malformed bytes cannot inherit active session identity",
  );
  endChatDrag();
}

beginChatSessionDrag(payload);
const nonChatTransfers = [
  transfer({ "text/plain": "drop me" }),
  transfer({ "text/uri-list": "file:///fixture/image.png" }),
  transfer({ "text/html": "<b>drop me</b>" }),
  transfer({}, ["Files"]),
  transfer(
    {},
    {
      0: "Files",
      length: 1,
      contains() {
        throw new Error("Unavailable contains");
      },
    },
  ),
  transfer({}, [], { files: { length: 1 } }),
  transfer({}, [], { items: [{ kind: "file" }] }),
  transfer({ "text/plain": "drop me" }, undefined, {
    get types() {
      throw new Error("Protected types");
    },
  }),
  transfer({}, [], {
    get files() {
      throw new Error("Protected files");
    },
    items: [{ kind: "file" }],
  }),
  transfer({}, ["application/x-gyro-editor-group"]),
];
for (const other of nonChatTransfers) {
  assert.equal(
    chatDragSource(other),
    undefined,
    "ordinary text/files/editor drags are never captured by stale chat state",
  );
  assert.equal(readChatDrag(other), undefined);
}
for (const type of ["dragenter", "dragover"]) {
  for (const other of nonChatTransfers) {
    beginChatSessionDrag(payload);
    nativeEvent(type, other);
    assert.equal(
      currentChatDrag(),
      undefined,
      "an explicit external non-chat drag cancels stranded identity and hover feedback",
    );
  }
  const active = beginChatSessionDrag(payload);
  nativeEvent(type, inaccessible);
  nativeEvent(type, protectedTransfer);
  assert.equal(
    currentChatDrag(),
    active,
    "a protected native store cannot be mistaken for an external drag",
  );
}
beginChatSessionDrag(payload);
assert.deepEqual(
  readChatSessionDrag(
    nativeSession({ sessionId: "other", projectKey: "/fixture/Other" }),
  ),
  {
    sessionId: "other",
    projectKey: "/fixture/Other",
  },
  "explicit external session identity wins over a stale internal drag",
);
assert.equal(
  readChatDrag(
    transfer({
      [CHAT_SESSION_DRAG_MIME]: JSON.stringify(payload),
      [CHAT_PANE_DRAG_MIME]: "pane-alpha",
    }),
  ),
  undefined,
  "contradictory native chat identities are rejected",
);
assert.equal(
  readChatDrag(
    transfer({ [CHAT_SESSION_DRAG_MIME]: JSON.stringify(payload) }, [
      CHAT_SESSION_DRAG_MIME,
      "Files",
    ]),
  ),
  undefined,
  "file data cannot be converted to a chat even with chat MIME attached",
);

const paneDrag = beginChatPaneDrag({ paneId: "pane-alpha" });
assert.equal(
  currentChatSessionDrag(),
  undefined,
  "pane starts replace sidebar identity",
);
assert.equal(
  readChatDrag(inaccessible)?.paneId,
  "pane-alpha",
  "pane moves also survive protected WebKit payloads",
);
assert.equal(chatDragSource(protectedTransfer), "pane");
endChatDrag(firstDrag.dragId);
assert.equal(
  currentChatDrag(),
  paneDrag,
  "an old source cannot clear a newer pane drag",
);
const newerPaneDrag = beginChatPaneDrag({ paneId: "pane-alpha" });
endChatDrag(paneDrag.dragId);
assert.equal(
  currentChatDrag(),
  newerPaneDrag,
  "a repeated drag of the same identity has its own lifecycle token",
);
endChatDrag(newerPaneDrag.dragId);
assert.equal(currentChatDrag(), undefined);
assert.deepEqual(
  readChatDrag(transfer({ [CHAT_PANE_DRAG_MIME]: "pane-alpha" })),
  {
    kind: "pane",
    paneId: "pane-alpha",
  },
  "native pane identity remains available for local layout validation",
);
for (const id of ["", " ", "pane\n", "p".repeat(513)]) {
  assert.equal(
    readChatDrag(transfer({ [CHAT_PANE_DRAG_MIME]: id })),
    undefined,
  );
}

const written = {};
const writable = {
  types: [],
  getData: (type) => written[type] ?? "",
  setData: (type, value) => {
    written[type] = value;
  },
};
const writtenDrag = beginChatPaneDrag({ paneId: "pane-alpha" }, writable);
assert.equal(written[CHAT_PANE_DRAG_MIME], "pane-alpha");
assert.equal(
  written["text/plain"],
  undefined,
  "internal identity never becomes composer text",
);
assert.equal(readChatDrag(writable), writtenDrag);
const newerWrittenDrag = beginChatPaneDrag({ paneId: "pane-alpha" });
const dragIdType = "application/x-gyro-chat-drag-id";
const oldTokenOnly = transfer({ [dragIdType]: written[dragIdType] });
assert.equal(
  chatDragSource(oldTokenOnly),
  "session",
  "a surviving chat token is intercepted when source MIME disappears",
);
assert.equal(
  readChatDrag(oldTokenOnly),
  undefined,
  "a stale token alone cannot move a chat",
);
for (const type of ["dragenter", "dragover"]) {
  nativeEvent(type, writable);
  nativeEvent(type, oldTokenOnly);
  assert.equal(
    currentChatDrag(),
    newerWrittenDrag,
    "older chat drag events cannot cancel the newer identity",
  );
}
assert.equal(
  readChatDrag(writable),
  undefined,
  "an old token cannot move a previous pane after another drag begins",
);
assert.equal(
  chatDragSource(transfer({}, [dragIdType])),
  "pane",
  "a protected marker remains associated with the active pane",
);
assert.equal(
  readChatDrag(transfer({}, [dragIdType])),
  newerWrittenDrag,
  "a protected current marker preserves the active identity",
);
assert.equal(
  chatDragSource(writable),
  "pane",
  "old chat native data remains intercepted",
);
endChatDragForTransfer(writable);
assert.equal(
  currentChatDrag(),
  newerWrittenDrag,
  "a stale handled drop cannot clear a newer drag",
);
nativeEvent("dragend", writable);
await Promise.resolve();
assert.equal(
  currentChatDrag(),
  newerWrittenDrag,
  "an old native token cannot end a newer same-pane drag",
);
endChatDragForTransfer(protectedTransfer);
assert.equal(
  currentChatDrag(),
  undefined,
  "a protected current transfer can complete its drag",
);
assert.equal(
  chatDragSource(transfer({}, [dragIdType])),
  "session",
  "a protected marker remains interceptable after cancellation",
);
assert.equal(
  readChatDrag(transfer({}, [dragIdType])),
  undefined,
  "a marker without identity never creates a drag",
);
assert.equal(
  readChatDrag(writable),
  undefined,
  "old renderer tokens cannot resurrect after cancellation",
);
assert.deepEqual(
  readChatDrag(
    transfer({
      [CHAT_SESSION_DRAG_MIME]: JSON.stringify(payload),
      "application/x-gyro-chat-drag-id": "another-renderer:17",
    }),
  ),
  { kind: "session", ...payload },
  "foreign renderer tokens remain available for authoritative external session validation",
);
const unwritable = transfer({}, [], {
  setData() {
    throw new Error("Protected writer");
  },
});
beginChatSessionDrag(payload, unwritable);
assert.deepEqual(
  readChatSessionDrag(inaccessible),
  payload,
  "a rejected native write preserves the fallback",
);

// Capture listeners end stale drags regardless of React propagation, while
// queued cleanup preserves the identity during drop handlers themselves.
nativeEvent("drop", protectedTransfer);
assert.deepEqual(
  currentChatSessionDrag(),
  payload,
  "drop capture must leave identity readable until the handler runs",
);
await Promise.resolve();
assert.equal(
  currentChatDrag(),
  undefined,
  "stopped/outside drops still end the drag after dispatch",
);
beginChatSessionDrag(payload);
nativeEvent("dragstart", transfer({ "text/plain": "other" }));
assert.equal(
  currentChatDrag(),
  undefined,
  "starting any unrelated native drag clears protected fallback",
);
for (const [type, properties] of [
  ["blur", {}],
  ["pagehide", {}],
  ["keydown", { key: "Escape" }],
]) {
  beginChatSessionDrag(payload);
  nativeEvent(type, undefined, properties);
  assert.equal(
    currentChatDrag(),
    undefined,
    `${type} cancels identity and hover subscribers`,
  );
}
beginChatPaneDrag({ paneId: "pane-alpha" });
document.visibilityState = "hidden";
document.dispatchEvent(new Event("visibilitychange"));
assert.equal(
  currentChatDrag(),
  undefined,
  "backgrounding the renderer cancels the drag",
);
document.visibilityState = "visible";
beginChatSessionDrag(payload);
nativeEvent("dragend", inaccessible);
await Promise.resolve();
assert.equal(
  currentChatDrag(),
  undefined,
  "protected native dragend completes the lifecycle",
);

const domStringList = {
  length: 1,
  contains: (value) => value === CHAT_SESSION_DRAG_MIME,
  item: () => CHAT_SESSION_DRAG_MIME,
};
assert.equal(
  chatDragSource(transfer({}, domStringList)),
  "session",
  "WebKit DOMStringList is supported without includes",
);
assert.equal(
  chatDragSource(
    transfer({}, [], {
      get types() {
        throw new Error("Unavailable types");
      },
    }),
  ),
  undefined,
);
beginChatSessionDrag(payload);
assert.equal(
  beginChatSessionDrag({ sessionId: "", projectKey: "" }),
  undefined,
);
assert.equal(
  currentChatDrag(),
  undefined,
  "invalid new sources cannot keep old identity alive",
);
assert.ok(notifications.some((drag) => drag?.kind === "pane"));
assert.equal(
  notifications.at(-1),
  undefined,
  "cancellations reach lifecycle subscribers",
);
const countBeforeUnsubscribe = notifications.length;
unsubscribe();
beginChatSessionDrag(payload);
endChatDrag();
assert.equal(
  notifications.length,
  countBeforeUnsubscribe,
  "unmounted subscribers are removed",
);

const pane = (id) => ({
  paneId: id,
  kind: "session",
  sessionId: id,
  workspacePath: "/fixture/Gyro",
});
const bounds = { left: 240, top: 50, width: 960, height: 600 };
const at = (zones, fraction, y = 350) =>
  chatGridDropZoneBeforePaint(
    zones,
    bounds,
    bounds.left + bounds.width * fraction,
    y,
  );
assert.equal(at(chatGridDropZones([], "columns"), 0.5)?.id, "full");
const split = chatGridDropZones([pane("alpha")], "columns");
assert.equal(at(split, 0.02)?.id, "left");
assert.equal(at(split, 0.98)?.id, "right");
for (const count of [2, 3, 4]) {
  const slots = Array.from({ length: count }, (_, index) =>
    pane(String(index)),
  );
  const zones = chatGridDropZones(slots, "columns", true);
  assert.equal(zones.length, count + 1);
  for (let boundary = 0; boundary <= count; boundary++) {
    assert.equal(
      at(zones, boundary / count)?.id,
      zones[boundary].id,
      "fast release follows the row's actual boundary",
    );
  }
  if (count === 4)
    assert.equal(
      at(chatGridDropZones(slots, "columns"), 0.98),
      undefined,
      "a full split cannot accept a new chat",
    );
}
const quadrants = chatGridDropZones([pane("a"), pane("b"), pane("c")], "grid");
assert.equal(at(quadrants, 0.25, 100)?.slotIndex, 0);
assert.equal(at(quadrants, 0.75, 100)?.slotIndex, 1);
assert.equal(at(quadrants, 0.25, 600)?.slotIndex, 2);
assert.equal(at(quadrants, 0.75, 600)?.slotIndex, 3);
console.log(
  "Chat drag checks passed: payload validation, native lifecycle, protected sessions/panes, unrelated transfers, fast releases, reordering, capacity, quadrants.",
);
