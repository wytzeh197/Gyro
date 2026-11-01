import assert from "node:assert/strict";
import {
  chatGridReducer,
  chatPaneIdentity,
  resolveChatGridDropSlot,
} from "../packages/ui/src/workbench-state.ts";

const PROJECT = "/fixture/Gyro";
const pane = (id, paneId = `pane:${id}`) => ({
  kind: "session",
  paneId,
  sessionId: id,
  workspacePath: PROJECT,
});
const stateOf = (slots, extra = {}) => ({
  activeProjectKey: PROJECT,
  layouts: {
    [PROJECT]: {
      projectKey: PROJECT,
      slots,
      focusedPaneId: slots.find(Boolean)?.paneId,
      arrangement: "grid",
      ...extra,
    },
  },
});
const slotsOf = (state) => state.layouts[PROJECT].slots;
const ids = (slots) => slots.filter(Boolean).map(chatPaneIdentity).sort();
const drop = (state, incoming, slotIndex, placement = {}) =>
  chatGridReducer(state, {
    type: "select-pane",
    projectKey: PROJECT,
    mode: "drop",
    pane: incoming,
    slotIndex,
    ...placement,
  });
const move = (state, moving, slotIndex, placement = {}) =>
  chatGridReducer(state, {
    type: "move-pane",
    projectKey: PROJECT,
    paneId: moving.paneId,
    slotIndex,
    ...placement,
  });
function assertLayout(state, expectedIds) {
  const slots = slotsOf(state);
  assert.equal(slots.length, 4);
  assert.deepEqual(ids(slots), expectedIds);
  assert.equal(
    new Set(slots.filter(Boolean).map((p) => p.paneId)).size,
    expectedIds.length,
  );
  assert.ok(
    slots.some((p) => p?.paneId === state.layouts[PROJECT].focusedPaneId),
  );
}

// Every occupancy pattern and pointer quadrant must preserve all open chats.
// Full layouts reject incoming chats instead of replacing one under a stale
// overlay. The resolver and reducer must agree on the actual landing cell.
for (let mask = 0; mask < 16; mask += 1) {
  const slots = Array.from({ length: 4 }, (_, index) =>
    mask & (1 << index) ? pane(String(index)) : null,
  );
  const state = stateOf(slots);
  const original = structuredClone(state);
  for (let target = 0; target < 4; target += 1) {
    const incoming = pane("incoming");
    const resolved = resolveChatGridDropSlot(slots, target);
    const result = drop(state, incoming, target);
    if (mask === 15) {
      assert.equal(resolved, undefined);
      assert.equal(
        result,
        state,
        "full quadrant drop preserves state and all chats",
      );
    } else {
      assert.ok(resolved);
      assertLayout(result, [...ids(slots), chatPaneIdentity(incoming)].sort());
      assert.equal(slotsOf(result)[resolved.targetIndex], incoming);
      if (resolved.displacedIndex !== undefined) {
        assert.equal(slotsOf(result)[resolved.displacedIndex], slots[target]);
      }
    }
    assert.deepEqual(state, original, "drop must not mutate its prior state");
  }

  // Sidebar drags preserve the original pane/key even if the supplied pane id
  // differs. Pane drags perform the same swap and retain every conversation.
  for (const moving of slots.filter(Boolean)) {
    for (let target = 0; target < 4; target += 1) {
      const from = slots.indexOf(moving);
      const bySession = drop(
        state,
        pane(moving.sessionId, "different-key"),
        target,
      );
      const byPane = move(state, moving, target);
      assert.deepEqual(bySession, byPane);
      assertLayout(bySession, ids(slots));
      assert.equal(slotsOf(bySession)[target], moving);
      if (from === target)
        assert.equal(bySession, state, "source quadrant is a strict no-op");
      else assert.equal(slotsOf(bySession)[from], slots[target]);
    }
  }
}

// Exhaustively exercise every before/after row boundary from every source,
// including layouts with holes. Model the expected order independently by
// removing the source and inserting beside the target's identity.
for (const arrangement of ["columns", "rows"]) {
  for (let mask = 1; mask < 16; mask += 1) {
    const slots = Array.from({ length: 4 }, (_, index) =>
      mask & (1 << index) ? pane(String(index)) : null,
    );
    const occupied = slots.filter(Boolean);
    const state = stateOf(slots, { arrangement });
    state.maximizedPaneId = occupied.at(-1).paneId;
    for (const moving of occupied) {
      for (const target of occupied) {
        for (const insertPosition of ["before", "after"]) {
          const placement = { insertPosition, arrangement };
          const remaining = occupied.filter((p) => p !== moving);
          if (target !== moving) {
            const targetPosition = remaining.indexOf(target);
            remaining.splice(
              targetPosition + (insertPosition === "after" ? 1 : 0),
              0,
              moving,
            );
          }
          const expected = target === moving ? occupied : remaining;
          const result = drop(
            state,
            pane(moving.sessionId, "different-key"),
            slots.indexOf(target),
            placement,
          );
          const byPane = move(state, moving, slots.indexOf(target), placement);
          assert.deepEqual(
            result,
            byPane,
            "sidebar and pane row placements agree",
          );
          assertLayout(result, ids(slots));
          assert.deepEqual(slotsOf(result).filter(Boolean), expected);
          if (expected.every((p, index) => p === occupied[index])) {
            assert.equal(
              result,
              state,
              "same/adjacent boundary preserves focus and maximization",
            );
          } else {
            assert.equal(result.layouts[PROJECT].focusedPaneId, moving.paneId);
            assert.equal(result.layouts[PROJECT].arrangement, arrangement);
            if (occupied.length === 2)
              assert.equal(
                result.layouts[PROJECT].splitDirection,
                arrangement === "rows" ? "vertical" : "horizontal",
              );
          }
        }
      }
    }
    for (const target of occupied) {
      for (const insertPosition of ["before", "after"]) {
        const incoming = pane("new");
        const result = drop(state, incoming, slots.indexOf(target), {
          insertPosition,
          arrangement,
        });
        if (occupied.length === 4) assert.equal(result, state);
        else {
          const expected = [...occupied];
          expected.splice(
            occupied.indexOf(target) + (insertPosition === "after" ? 1 : 0),
            0,
            incoming,
          );
          assertLayout(
            result,
            [...ids(slots), chatPaneIdentity(incoming)].sort(),
          );
          assert.deepEqual(slotsOf(result).filter(Boolean), expected);
          assert.equal(result.layouts[PROJECT].arrangement, arrangement);
          if (occupied.length === 1)
            assert.equal(
              result.layouts[PROJECT].splitDirection,
              arrangement === "rows" ? "vertical" : "horizontal",
            );
        }
      }
    }
  }
}

const initial = stateOf([pane("a"), pane("b"), null, null]);
initial.maximizedPaneId = "pane:b";
for (const invalid of [-1, 4, 10, 0.5, NaN, Infinity, -Infinity, null, "1"]) {
  assert.equal(resolveChatGridDropSlot(slotsOf(initial), invalid), undefined);
  assert.equal(drop(initial, pane("new"), invalid), initial);
  assert.equal(drop(initial, pane("a"), invalid), initial);
  assert.equal(move(initial, pane("a"), invalid), initial);
}
for (const incoming of [pane("new"), pane("a")]) {
  assert.equal(
    drop(initial, incoming, 2, { insertPosition: "before" }),
    initial,
    "stale row target in an empty cell is rejected",
  );
  assert.equal(
    drop(initial, incoming, 0, { insertPosition: "invalid" }),
    initial,
  );
}
assert.equal(move(initial, pane("a"), 2, { insertPosition: "after" }), initial);
assert.equal(move(initial, pane("missing"), 0), initial);
assert.equal(
  chatGridReducer(initial, {
    type: "move-pane",
    projectKey: "/fixture/elsewhere",
    paneId: "pane:a",
    slotIndex: 0,
  }),
  initial,
  "stale moves must not create/activate another project's layout",
);
assert.equal(
  drop(initial, { ...pane("foreign"), workspacePath: "/fixture/elsewhere" }, 0),
  initial,
);
assert.equal(
  drop(initial, pane("a"), 0),
  initial,
  "same-pane sidebar drop does not change focus/maximization",
);
assert.equal(move(initial, pane("a"), 0), initial);

// Distinct chats with colliding React keys receive unique ids; an existing
// chat always reuses its original pane even after a draft became a session.
const collided = drop(initial, pane("new", "pane:a"), 2);
assertLayout(collided, ["session:a", "session:b", "session:new"]);
assert.notEqual(slotsOf(collided)[2].paneId, "pane:a");
const formerlyDraft = stateOf([
  { ...pane("a"), paneId: "draft:old" },
  pane("b"),
  null,
  null,
]);
const movedDraft = drop(formerlyDraft, pane("a"), 1);
assert.equal(slotsOf(movedDraft)[1].paneId, "draft:old");
assert.equal(slotsOf(movedDraft)[0].sessionId, "b");

// Sparse/short caller arrays still resolve only within the four valid cells.
assert.deepEqual(resolveChatGridDropSlot([pane("a")], 0), {
  displacedIndex: 2,
  targetIndex: 0,
});
assert.equal(
  resolveChatGridDropSlot(
    [pane("a"), pane("b"), pane("c"), pane("d"), null],
    0,
  ),
  undefined,
);

console.log(
  "Chat grid drag state passed: exhaustive quadrants, row insertion, no eviction, invalid/stale gestures, no-op focus, stable pane identities.",
);
