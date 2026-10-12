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

// Independent rectangles for the CSS overlay: padding 10, gutter 8; linear
// insertion bars 8 wide and pane tracks separated by 1 pixel. This exercises
// a release before the targets exist against the visible overlay geometry.
function renderedTargets(zones, rectangle = bounds) {
  const { left, top, width, height } = rectangle;
  const layout = chatGridDropLayout(zones);
  if (layout === "row" || layout === "stack") {
    const horizontal = layout === "row";
    const length = horizontal ? width : height;
    const offset = horizontal ? left : top;
    const panes = zones.length - 1;
    const paneSize = (length - (panes - 1)) / panes;
    return zones.map((zone, index) => {
      const start =
        index === 0
          ? offset
          : index === panes
            ? offset + length - 8
            : offset + (paneSize + 1) * index - 4;
      return horizontal
        ? target(zone.position, start, top, start + 8, top + height)
        : target(zone.position, left, start, left + width, start + 8);
    });
  }
  const columns = layout === "full" ? 1 : 2;
  const rows = layout === "positions" ? 2 : 1;
  const innerWidth = width - 20;
  const innerHeight = height - 20;
  const tileWidth = (innerWidth - (columns - 1) * 8) / columns;
  const tileHeight = (innerHeight - (rows - 1) * 8) / rows;
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

// Reordering treats the whole neighbouring pane as a destination, in either
// direction, while exact insertion bars and the source itself keep their zone.
for (const rectangle of [bounds,
  { left: -713.25, top: -80.5, width: 517.5, height: 301.25 },
]) {
  for (const arrangement of ["columns", "rows"]) {
    for (const slots of [
      fullSlots.slice(0, 2), fullSlots.slice(0, 3), fullSlots,
      [null, pane("sparse-a"), null, pane("sparse-b")],
    ]) {
      const zones = chatGridDropZones(slots, arrangement, true);
      const targets = renderedTargets(zones, rectangle);
      const count = zones.length - 1;
      const horizontal = arrangement === "columns";
      const track = ((horizontal ? rectangle.width : rectangle.height) + 1) / count;
      for (let source = 0; source < count; source++) {
        const sourceSlot = zones[source].slotIndex;
        for (let destination = 0; destination < count; destination++) {
          for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
            const x = rectangle.left + (horizontal
              ? track * (destination + fraction) : rectangle.width / 2);
            const y = rectangle.top + (horizontal
              ? rectangle.height / 2 : track * (destination + fraction));
            const expected = destination === source
              ? chatGridDropZoneBeforePaint(zones, rectangle, x, y)
              : zones[destination < source ? destination : destination + 1];
            assert.equal(chatGridDropZoneBeforePaint(
              zones, rectangle, x, y, sourceSlot,
            )?.id, expected?.id);
            assert.equal(nearestChatGridDropZone(
              targets, zones, x, y, rectangle, sourceSlot,
            )?.id, expected?.id);
          }
        }
        // Exact bars still support precise placement and cancellation.
        for (let index = 0; index < targets.length; index++) {
          const r = targets[index].getBoundingClientRect();
          const x = (r.left + r.right) / 2;
          const y = (r.top + r.bottom) / 2;
          assert.equal(chatGridDropZoneBeforePaint(
            zones, rectangle, x, y, sourceSlot,
          )?.id, zones[index].id);
          assert.equal(nearestChatGridDropZone(
            targets, zones, x, y, rectangle, sourceSlot,
          )?.id, zones[index].id);
        }
      }
    }
  }
}

// Explicit regressions: a seam bar straddles a pane boundary while edge bars
// are inset. Equal-width rounding picks the wrong edge near these midpoints.
const row = chatGridDropZones(fullSlots.slice(0, 2), "columns");
assert.equal(
  chatGridDropZoneBeforePaint(row, bounds, 482, 350)?.id,
  "row-start",
);
assert.equal(
  chatGridDropZoneBeforePaint(row, bounds, 483, 350)?.id,
  "row-seam-1",
);
assert.equal(chatGridDropZoneBeforePaint(row, bounds, 959, 350)?.id, "row-end");
const stack = chatGridDropZones(fullSlots.slice(0, 2), "rows");
assert.equal(
  chatGridDropZoneBeforePaint(stack, bounds, 720, 202)?.id,
  "stack-start",
);
assert.equal(
  chatGridDropZoneBeforePaint(stack, bounds, 720, 203)?.id,
  "stack-seam-1",
);
assert.equal(
  chatGridDropZoneBeforePaint(stack, bounds, 720, 499)?.id,
  "stack-end",
);
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
