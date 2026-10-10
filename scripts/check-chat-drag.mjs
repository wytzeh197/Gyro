import assert from "node:assert/strict";
import { beginChatSessionDrag, currentChatSessionDrag, endChatSessionDrag, readChatSessionDrag, CHAT_SESSION_DRAG_MIME } from "../packages/ui/src/chat-session-drag.ts";
import { chatGridDropZones, chatGridDropZoneBeforePaint } from "../packages/ui/src/chat-grid-drop.ts";

const payload = { sessionId: "beta", projectKey: "/fixture/Gyro" };
const inaccessible = { getData() { throw new Error("Protected data store"); } };
beginChatSessionDrag(payload);
assert.deepEqual(readChatSessionDrag(inaccessible), payload, "internal identity survives unreadable native bytes");
assert.deepEqual(readChatSessionDrag({ getData: () => "" }), payload);
endChatSessionDrag("other");
assert.deepEqual(currentChatSessionDrag(), payload, "a different row's dragend must not clear this drag");
endChatSessionDrag("beta");
assert.equal(currentChatSessionDrag(), undefined);
assert.equal(readChatSessionDrag(inaccessible), undefined);
assert.deepEqual(readChatSessionDrag({ getData: type => type === CHAT_SESSION_DRAG_MIME ? JSON.stringify(payload) : "" }), payload);
for (const raw of ["bad json", "null", "[]", '{"sessionId":7}', '{"sessionId":""}']) {
  assert.equal(readChatSessionDrag({ getData: () => raw }), undefined);
}
beginChatSessionDrag(payload);
endChatSessionDrag();
assert.equal(currentChatSessionDrag(), undefined, "cancelled/outside drops leave no stale identity");

const pane = id => ({ paneId: id, kind: "session", sessionId: id, workspacePath: "/fixture/Gyro" });
const bounds = { left: 240, top: 50, width: 960, height: 600 };
const at = (zones, fraction, y = 350) => chatGridDropZoneBeforePaint(zones, bounds, bounds.left + bounds.width * fraction, y);
assert.equal(at(chatGridDropZones([], "columns"), 0.5)?.id, "full");
const split = chatGridDropZones([pane("alpha")], "columns");
assert.equal(at(split, 0.02)?.id, "left");
assert.equal(at(split, 0.98)?.id, "right");
for (const count of [2, 3, 4]) {
  const slots = Array.from({ length: count }, (_, index) => pane(String(index)));
  const zones = chatGridDropZones(slots, "columns", true);
  assert.equal(zones.length, count + 1);
  for (let boundary = 0; boundary <= count; boundary++) {
    assert.equal(at(zones, boundary / count)?.id, zones[boundary].id, "fast release follows the row's actual boundary");
  }
  if (count === 4) assert.equal(at(chatGridDropZones(slots, "columns"), 0.98), undefined, "a full split cannot accept a new chat");
}
const quadrants = chatGridDropZones([pane("a"), pane("b"), pane("c")], "grid");
assert.equal(at(quadrants, 0.25, 100)?.slotIndex, 0);
assert.equal(at(quadrants, 0.75, 100)?.slotIndex, 1);
assert.equal(at(quadrants, 0.25, 600)?.slotIndex, 2);
assert.equal(at(quadrants, 0.75, 600)?.slotIndex, 3);
console.log("Chat drag checks passed: protected payloads, cleanup, fast releases, reordering, capacity, quadrants.");
