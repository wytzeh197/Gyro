// Chat-grid drop targets.
//
// The grid tiles panes by `ChatGridArrangement`, so the targets a drop can
// choose have to match what is on screen:
// - an empty grid opens the first chat full size;
// - a lone chat splits Left / Right, which is the two-pane row every later
//   drop joins;
// - a row of two or three chats has only its edges and its seams left, so each
//   target is a bar on that boundary and the row stays one row of equal
//   columns;
// - anything else that still has room offers the 2×2 quadrants;
// - a full row accepts rearrangement of its own chats, but no new chat.
import type { ChatGridArrangement, ChatPaneRef } from "./types";
import { CHAT_GRID_MAX_SLOTS } from "./workbench-state.ts";

export type ChatGridDropPlacement = {
  /** Kept by the drop so an edited row stays a row, never a 2×2 grid. */
  arrangement?: ChatGridArrangement;
  insertPosition: "before" | "after";
  splitDirection?: "horizontal" | "vertical";
};

export type ChatGridDropZone = {
  id: string;
  label: string;
  placement?: ChatGridDropPlacement;
  position: string;
  slotIndex: number;
};

/** The overlay template a zone set renders as; each maps to one CSS layout. */
export type ChatGridDropLayout = "columns" | "full" | "positions" | "row";

const CHAT_GRID_QUADRANT_LABELS = [
  "Top left",
  "Top right",
  "Bottom left",
  "Bottom right",
];

/**
 * Which overlay template a zone set belongs to. Read back from the zones
 * rather than recomputed from the layout, so the bars on screen and the
 * geometry a drop resolves against cannot drift apart.
 */
export function chatGridDropLayout(
  zones: ChatGridDropZone[],
): ChatGridDropLayout {
  const position = zones[0]?.position;
  if (position === "full") return "full";
  if (position?.startsWith("row-")) return "row";
  if (position === "left" || position === "right") return "columns";
  return "positions";
}

export function chatGridDropZones(
  slots: Array<ChatPaneRef | null>,
  arrangement: ChatGridArrangement,
  allowFullRowReorder = false,
): ChatGridDropZone[] {
  const occupied = slots.flatMap((pane, slotIndex) =>
    pane ? [slotIndex] : [],
  );
  // First chat into an empty grid: a single full-height/full-width target.
  if (occupied.length === 0) {
    return [{ id: "full", label: "Open here", position: "full", slotIndex: 0 }];
  }
  // Second chat: a full-height Left / Right split — two panes tile side by side.
  const [firstSlot] = occupied;
  if (occupied.length === 1 && firstSlot !== undefined) {
    return [
      {
        id: "left",
        label: "Left",
        placement: { insertPosition: "before", splitDirection: "horizontal" },
        position: "left",
        slotIndex: firstSlot,
      },
      {
        id: "right",
        label: "Right",
        placement: { insertPosition: "after", splitDirection: "horizontal" },
        position: "right",
        slotIndex: firstSlot,
      },
    ];
  }
  // A row holds up to four chats. At capacity, its boundaries are available
  // only to move a chat already in that row.
  if (arrangement === "columns") {
    return occupied.length < CHAT_GRID_MAX_SLOTS || allowFullRowReorder
      ? chatGridRowDropZones(occupied)
      : [];
  }
  // Anything else: place into a 2×2 grid position (the quadrants fill in).
  return CHAT_GRID_QUADRANT_LABELS.map((label, index) => ({
    id: `slot-${index}`,
    label,
    position: `position-${index + 1}`,
    slotIndex: index,
  }));
}

/**
 * Chats that already share the width only leave room on the two edges and the
 * seams between neighbours — one thin bar per boundary, and every one of them
 * keeps the row a single row. Each slot index names the pane the chat lands
 * beside, and the arrangement rides along so the row survives the drop.
 */
function chatGridRowDropZones(occupied: number[]): ChatGridDropZone[] {
  const zones: ChatGridDropZone[] = [];
  occupied.forEach((slotIndex, index) => {
    const placement = {
      arrangement: "columns",
      insertPosition: "before",
    } as const;
    zones.push(
      index === 0
        ? {
            id: "row-start",
            label: "Left edge",
            placement,
            position: "row-start",
            slotIndex,
          }
        : {
            id: `row-seam-${index}`,
            label: `Between chat ${index} and chat ${index + 1}`,
            placement,
            position: `row-seam-${index}`,
            slotIndex,
          },
    );
  });
  const lastSlot = occupied[occupied.length - 1];
  if (lastSlot !== undefined) {
    zones.push({
      id: "row-end",
      label: "Right edge",
      placement: { arrangement: "columns", insertPosition: "after" },
      position: "row-end",
      slotIndex: lastSlot,
    });
  }
  return zones;
}

/**
 * Resolve the zone that owns a pointer position by distance to the rendered
 * targets. The hover preview and the drop itself both use this, so the lit
 * target is always the one a release would land on — including in the gaps and
 * padding between tiles, where no zone contains the pointer at all.
 */
export function nearestChatGridDropZone(
  targets: ArrayLike<HTMLElement>,
  zones: ChatGridDropZone[],
  x: number,
  y: number,
): ChatGridDropZone | undefined {
  let nearest: ChatGridDropZone | undefined;
  let distance = Infinity;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    const bounds = target.getBoundingClientRect();
    const dx = Math.max(bounds.left - x, 0, x - bounds.right);
    const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
    const candidateDistance = dx * dx + dy * dy;
    const zone = zones.find(
      (item) => item.position === target.dataset.position,
    );
    if (zone && candidateDistance < distance) {
      nearest = zone;
      distance = candidateDistance;
    }
  }
  return nearest;
}
