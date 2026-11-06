import assert from "node:assert/strict";

import {
  chatGridDropLayout,
  chatGridDropZoneBeforePaint,
  chatGridDropZones,
  nearestChatGridDropZone,
} from "../packages/ui/src/chat-grid-drop.ts";

const pane = (id) => ({
  kind: "session",
  paneId: `pane:${id}`,
  sessionId: id,
  workspacePath: "/fixture/Gyro",
});
const bounds = { left: 240, top: 50, width: 960, height: 600 };
const target = (position, left, top, right, bottom) => ({
  dataset: { position },
  getBoundingClientRect: () => ({ left, top, right, bottom }),
});

// Independent CSS rectangles: every layout uses padding 10 and gutter 8.
// Compare early releases with the broad tiles the user can actually see.
function renderedTargets(zones, rectangle = bounds) {
  const { left, top, width, height } = rectangle;
  const layout = chatGridDropLayout(zones);
  const columns = layout === "row" ? zones.length
    : layout === "full" || layout === "stack" ? 1 : 2;
  const rows = layout === "stack" ? zones.length
    : layout === "positions" ? 2 : 1;
  const tileWidth = (width - 20 - (columns - 1) * 8) / columns;
  const tileHeight = (height - 20 - (rows - 1) * 8) / rows;
  return zones.map((zone, index) => {
    const x = left + 10 + (index % columns) * (tileWidth + 8);
    const y = top + 10 + Math.floor(index / columns) * (tileHeight + 8);
    return target(zone.position, x, y, x + tileWidth, y + tileHeight);
  });
}

// Every sparse four-slot shape must name real occupied slots, preserve its
// arrangement, and block a fifth chat in either linear arrangement.
for (let mask = 0; mask < 16; mask++) {
  const slots = Array.from({ length: 4 }, (_, index) =>
    mask & (1 << index) ? pane(String(index)) : null,
  );
  const occupied = slots.flatMap((item, index) => (item ? [index] : []));
  for (const arrangement of ["columns", "rows", "grid"]) {
    for (const reordering of [false, true]) {
      const zones = chatGridDropZones(slots, arrangement, reordering);
      assert.equal(new Set(zones.map((zone) => zone.id)).size, zones.length);
      assert.ok(
        zones.every((zone) => zone.slotIndex >= 0 && zone.slotIndex < 4),
      );
      if (!occupied.length) {
        assert.deepEqual(
          zones.map((zone) => zone.id),
          ["full"],
        );
      } else if (occupied.length === 1) {
        assert.deepEqual(
          zones.map((zone) => zone.id),
          ["left", "right"],
        );
        assert.ok(zones.every((zone) => zone.slotIndex === occupied[0]));
      } else if (occupied.length === 4 && !reordering) {
        assert.deepEqual(zones, []);
      } else if (arrangement === "grid") {
        assert.deepEqual(
          zones.map((zone) => zone.slotIndex),
          [0, 1, 2, 3],
        );
      } else {
        assert.equal(zones.length, occupied.length + 1);
        assert.deepEqual(
          zones.map((zone) => zone.slotIndex),
          [...occupied, occupied.at(-1)],
        );
        assert.ok(
          zones.every((zone) => zone.placement.arrangement === arrangement),
        );
        assert.equal(zones.at(-1).placement.insertPosition, "after");
        assert.ok(
          zones
            .slice(0, -1)
            .every((zone) => zone.placement.insertPosition === "before"),
        );
        assert.equal(
          chatGridDropLayout(zones),
          arrangement === "columns" ? "row" : "stack",
        );
      }
    }
  }
}
const fullSlots = Array.from({ length: 4 }, (_, index) => pane(String(index)));
assert.deepEqual(
  chatGridDropZones([...fullSlots, pane("overflow")], "columns", true),
  chatGridDropZones(fullSlots, "columns", true),
  "corrupt extra slots cannot create out-of-range destinations",
);
assert.deepEqual(
  chatGridDropZones([null, null, null, null, pane("overflow")], "columns"),
  chatGridDropZones([], "columns"),
);

// Corners become quadrants only after two chats are already open. This
// applies to every sparse layout, both linear orientations, and fast drops.
for (const arrangement of ["columns", "rows", "grid"]) {
  for (const [x, y, slotIndex] of [[0.1,0.1,0],[0.9,0.1,1],[0.1,0.9,2],[0.9,0.9,3]]) {
    const pointer = { bounds, x: bounds.left + bounds.width*x, y: bounds.top + bounds.height*y };
    const single = chatGridDropZones([pane("a")], arrangement, false, pointer);
    assert.equal(chatGridDropLayout(single), "columns");
    assert.ok(single.every(z=>z.placement?.arrangement !== "grid"));
    assert.equal(chatGridDropZoneBeforePaint(single,bounds,pointer.x,pointer.y)?.id, x<0.5 ? "left":"right");
    for (const slots of [fullSlots.slice(0,2), fullSlots.slice(0,3), [null,pane("a"),null,pane("b")]]) {
      const zones = chatGridDropZones(slots, arrangement, false, pointer);
      assert.equal(chatGridDropLayout(zones), "positions");
      const landing = chatGridDropZoneBeforePaint(zones,bounds,pointer.x,pointer.y);
      assert.equal(landing?.slotIndex,slotIndex);
      assert.equal(landing?.placement.arrangement,"grid");
      assert.equal(nearestChatGridDropZone(renderedTargets(zones),zones,pointer.x,pointer.y,bounds)?.id,landing.id);
      if(arrangement !== "grid") {
        assert.equal(nearestChatGridDropZone(renderedTargets(chatGridDropZones(slots,arrangement)),zones,pointer.x,pointer.y,bounds),undefined,
          "a stale row overlay cannot own a new corner release");
      }
    }
    assert.deepEqual(chatGridDropZones(fullSlots,arrangement,false,pointer),[]);
  }
}
const middle = chatGridDropZones(fullSlots.slice(0,2),"columns",false,{
  bounds,x:720,y:350,
});
assert.equal(chatGridDropLayout(middle),"row");
assert.equal(chatGridDropZoneBeforePaint(middle,bounds,720,350)?.id,"row-seam-1");

const fixtures = [
  chatGridDropZones([], "columns"),
  chatGridDropZones([pane("a")], "columns"),
  chatGridDropZones([pane("a"), pane("b"), pane("c")], "grid"),
  ...[2, 3, 4].flatMap((count) =>
    ["columns", "rows"].map((arrangement) =>
      chatGridDropZones(fullSlots.slice(0, count), arrangement, true),
    ),
  ),
];
let comparisons = 0;
for (const rectangle of [
  bounds,
  { left: -713.25, top: -80.5, width: 517.5, height: 301.25 },
]) {
  for (const zones of fixtures) {
    const targets = renderedTargets(zones, rectangle);
    // Sweep edges, padding, seams, gutters, and pane interiors at multiple
    // widths, heights, and fractional / negative viewport offsets.
    for (let xStep = 0; xStep <= 96; xStep++) {
      for (let yStep = 0; yStep <= 24; yStep++) {
        const x = rectangle.left + (rectangle.width * xStep) / 96;
        const y = rectangle.top + (rectangle.height * yStep) / 24;
        const beforePaint = chatGridDropZoneBeforePaint(zones, rectangle, x, y);
        assert.equal(
          nearestChatGridDropZone(targets, zones, x, y, rectangle)?.id,
          beforePaint?.id,
        );
        assert.equal(
          nearestChatGridDropZone(
            [...targets].reverse(),
            zones,
            x,
            y,
            rectangle,
          )?.id,
          beforePaint?.id,
          "DOM order cannot change tie ownership",
        );
        comparisons += 2;
      }
    }
  }
}

// Every neighbouring pane is a broad reorder destination. The source and
// either original source boundary cancel, preserving drafts and maximization.
for (const rectangle of [bounds,
  { left: -713.25, top: -80.5, width: 517.5, height: 301.25 },
]) {
  for (const arrangement of ["columns", "rows"]) {
    for (const slots of [
      fullSlots.slice(0, 2), fullSlots.slice(0, 3), fullSlots,
      [null, pane("sparse-a"), null, pane("sparse-b")],
    ]) {
      const occupied = slots.flatMap((p, index) => p ? [index] : []);
      const count = occupied.length;
      const horizontal = arrangement === "columns";
      const track = ((horizontal ? rectangle.width : rectangle.height) + 1) / count;
      for (let source = 0; source < count; source++) {
        const sourceSlot = occupied[source];
        const zones = chatGridDropZones(slots, arrangement, true, {
          bounds: rectangle, x: rectangle.left + rectangle.width / 2,
          y: rectangle.top + rectangle.height / 2, sourceSlotIndex: sourceSlot,
        });
        const targets = renderedTargets(zones, rectangle);
        assert.equal(zones.length, count);
        assert.equal(zones[source].isSource, true);
        for (let destination = 0; destination < count; destination++) {
          for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
            const x = rectangle.left + (horizontal
              ? track * (destination + fraction) : rectangle.width / 2);
            const y = rectangle.top + (horizontal
              ? rectangle.height / 2 : track * (destination + fraction));
            assert.equal(chatGridDropZoneBeforePaint(
              zones, rectangle, x, y, sourceSlot,
            )?.id, zones[destination].id);
            assert.equal(nearestChatGridDropZone(
              targets, zones, x, y, rectangle, sourceSlot,
            )?.id, zones[destination].id);
          }
        }
        for (const boundary of [source, source + 1]) {
          const offset = Math.min(track * boundary, horizontal ? rectangle.width : rectangle.height);
          const x = rectangle.left + (horizontal ? offset : rectangle.width / 2);
          const y = rectangle.top + (horizontal ? rectangle.height / 2 : offset);
          assert.equal(chatGridDropZoneBeforePaint(zones, rectangle, x, y, sourceSlot)?.id, zones[source].id);
          assert.equal(nearestChatGridDropZone(targets, zones, x, y, rectangle, sourceSlot)?.id, zones[source].id);
        }
      }
    }
  }
}

// Broad tile gutters have deterministic ownership on either side of a tie.
const row = chatGridDropZones(fullSlots.slice(0, 2), "columns");
assert.equal(chatGridDropZoneBeforePaint(row, bounds, 562, 350)?.id, "row-start");
assert.equal(chatGridDropZoneBeforePaint(row, bounds, 562.01, 350)?.id, "row-seam-1");
const stack = chatGridDropZones(fullSlots.slice(0, 2), "rows");
assert.equal(chatGridDropZoneBeforePaint(stack, bounds, 720, 252)?.id, "stack-start");
assert.equal(chatGridDropZoneBeforePaint(stack, bounds, 720, 252.01)?.id, "stack-seam-1");

const quadrants = fixtures[2];
assert.equal(
  chatGridDropZoneBeforePaint(quadrants, bounds, 720, 350)?.id,
  "slot-0",
  "exact center ties match the rendered top-left target",
);

for (const zones of fixtures) {
  const targets = renderedTargets(zones);
  for (const [x, y] of [
    [NaN, 350],
    [720, NaN],
    [Infinity, 350],
    [-Infinity, 350],
    [720, Infinity],
    [239.99, 350],
    [1200.01, 350],
    [720, 49.99],
    [720, 650.01],
  ]) {
    assert.equal(chatGridDropZoneBeforePaint(zones, bounds, x, y), undefined);
    assert.equal(
      nearestChatGridDropZone(targets, zones, x, y, bounds),
      undefined,
    );
  }
  for (const invalidBounds of [
    { ...bounds, width: 0 },
    { ...bounds, height: 0 },
    { ...bounds, width: -1 },
    { ...bounds, height: -1 },
    { ...bounds, left: NaN },
    { ...bounds, top: Infinity },
    { ...bounds, width: Infinity },
    { ...bounds, height: NaN },
    { ...bounds, left: Number.MAX_VALUE, width: Number.MAX_VALUE },
  ]) {
    assert.equal(
      chatGridDropZoneBeforePaint(zones, invalidBounds, 720, 350),
      undefined,
    );
    assert.equal(
      nearestChatGridDropZone(targets, zones, 720, 350, invalidBounds),
      undefined,
    );
  }
  assert.equal(
    nearestChatGridDropZone(targets.slice(1), zones, 720, 350, bounds),
    undefined,
    "partial overlays must use complete fallback geometry",
  );
  assert.equal(
    nearestChatGridDropZone([...targets, targets[0]], zones, 720, 350, bounds),
    undefined,
    "duplicate stale targets cannot bias a drop",
  );
  for (const rectangle of [
    [240, 50, 240, 650],
    [240, 50, 1200, 50],
    [1200, 50, 240, 650],
    [NaN, 50, 1200, 650],
    [240, 50, Infinity, 650],
  ]) {
    const invalidTarget = target(zones[0].position, ...rectangle);
    assert.equal(
      nearestChatGridDropZone(
        [invalidTarget, ...targets.slice(1)],
        zones,
        720,
        350,
        bounds,
      ),
      undefined,
      "hidden or invalid rendered rectangles cannot own a release",
    );
  }
  assert.equal(
    nearestChatGridDropZone(
      [...targets, target("obsolete-position", 0, 0, 10, 10)],
      zones,
      720,
      350,
      bounds,
    ),
    undefined,
    "obsolete overlay positions must use the current logical geometry",
  );
}
for (const zones of fixtures.slice(0, 3)) {
  assert.equal(
    chatGridDropZoneBeforePaint(
      zones,
      { left: 0, top: 0, width: 20, height: 20 },
      10,
      10,
    ),
    undefined,
    "unrenderable placement tiles have no fallback destination",
  );
}
assert.equal(nearestChatGridDropZone([], [], 720, 350, bounds), undefined);
assert.equal(chatGridDropZoneBeforePaint([], bounds, 720, 350), undefined);

console.log(
  `Chat drop geometry checks passed: ${comparisons} preview/release comparisons, sparse layouts, capacity, vertical stacks, ties, invalid coordinates, and stale overlays.`,
);
