// Chat-grid drop targets.
//
// The grid tiles panes by `ChatGridArrangement`, so the targets a drop can
// choose have to match what is on screen:
// - an empty grid opens the first chat full size;
// - a lone chat splits Left / Right;
// - two chats already in the layout swap; a new chat still picks an edge or corner;
// - three or more rows and stacks offer broad insertion tiles, with corners
//   offering a 2×2 grid; moving a chat already in the layout keeps a cancellation tile;
// - anything else that still has room offers the 2×2 quadrants;
// - a full row or stack accepts rearrangement of its own chats, but no new chat.
import type { ChatGridArrangement, ChatPaneRef } from "./types";
import { CHAT_GRID_MAX_SLOTS } from "./workbench-state.ts";

export type ChatGridDropPlacement = {
  arrangement?: ChatGridArrangement;
  insertPosition?: "before" | "after";
  splitDirection?: "horizontal" | "vertical";
};

export type ChatGridDropZone = {
  id: string;
  label: string;
  /** A broad reorder tile that leaves its source pane where it is. */
  isSource?: boolean;
  placement?: ChatGridDropPlacement;
  position: string;
  slotIndex: number;
};

/** The overlay template a zone set renders as; each maps to one CSS layout. */
export type ChatGridDropLayout =
  "columns" | "full" | "positions" | "row" | "stack";

type ChatGridDropBounds = Pick<DOMRect, "left" | "top" | "width" | "height">;
type DropRectangle = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
type ChatGridDropPointer = {
  bounds: ChatGridDropBounds;
  x: number;
  y: number;
  sourceSlotIndex?: number;
};

// These are the layout dimensions in styles.css / chat-design.css. Before
// React paints the overlay, its virtual targets need the same edges and gaps
// as the rendered tiles.
const DROP_OVERLAY_PADDING = 10;
const DROP_OVERLAY_GAP = 8;
const ROW_PANE_GAP = 1;
const REORDER_CANCEL_HALF_WIDTH = 4;

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
  if (position?.startsWith("stack-")) return "stack";
  if (position === "left" || position === "right") return "columns";
  return "positions";
}

export function chatGridDropZones(
  slots: Array<ChatPaneRef | null>,
  arrangement: ChatGridArrangement,
  allowFullRowReorder = false,
  pointer?: ChatGridDropPointer,
): ChatGridDropZone[] {
  const occupied = slots
    .slice(0, CHAT_GRID_MAX_SLOTS)
    .flatMap((pane, slotIndex) => (pane ? [slotIndex] : []));
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
  // At capacity every layout only accepts a chat already in it. Offering a
  // target to an incoming chat would promise placement the reducer rejects.
  if (occupied.length >= CHAT_GRID_MAX_SLOTS && !allowFullRowReorder) return [];
  // Two chats already open trade places. A release stays on that pane, so
  // the corner of a split does not open a row, stack, or 2×2 chooser.
  if (
    occupied.length === 2 &&
    allowFullRowReorder &&
    (arrangement === "columns" || arrangement === "rows")
  ) {
    const horizontal = arrangement === "columns";
    const sourceSlotIndex = pointer?.sourceSlotIndex ?? -1;
    return occupied.map((slotIndex, index) => {
      const position = horizontal
        ? index === 0
          ? "left"
          : "right"
        : index === 0
          ? "stack-start"
          : "stack-end";
      const isSource = slotIndex === sourceSlotIndex;
      return {
        id: position,
        label: isSource ? "Keep here" : "Swap",
        isSource: isSource || undefined,
        position,
        slotIndex,
      };
    });
  }
  if (arrangement === "columns" || arrangement === "rows") {
    if (pointer && pointerWithinBounds(pointer.bounds, pointer.x, pointer.y)) {
      const x = (pointer.x - pointer.bounds.left) / pointer.bounds.width;
      const y = (pointer.y - pointer.bounds.top) / pointer.bounds.height;
      if ((x <= 0.35 || x >= 0.65) && (y <= 0.25 || y >= 0.75)) {
        return chatGridQuadrantDropZones();
      }
    }
    const zones = chatGridLinearDropZones(occupied, arrangement);
    const source = occupied.indexOf(pointer?.sourceSlotIndex ?? -1);
    if (allowFullRowReorder && source >= 0) {
      // Before and after the source are the same no-op. One source tile and
      // one tile per neighbour make the whole neighbouring pane reachable.
      zones.splice(source + 1, 1);
      zones[source] = { ...zones[source]!, label: "Keep here", isSource: true };
    }
    return zones;
  }
  return chatGridQuadrantDropZones();
}

function chatGridQuadrantDropZones(): ChatGridDropZone[] {
  return CHAT_GRID_QUADRANT_LABELS.map((label, index) => ({
    id: `slot-${index}`,
    label,
    placement: { arrangement: "grid" },
    position: `position-${index + 1}`,
    slotIndex: index,
  }));
}

/**
 * Linear layouts offer broad tiles for the edges and seams between neighbours.
 * Each slot names the pane the chat lands next to, preserving the arrangement.
 */
function chatGridLinearDropZones(
  occupied: number[],
  arrangement: "columns" | "rows",
): ChatGridDropZone[] {
  const zones: ChatGridDropZone[] = [];
  const prefix = arrangement === "columns" ? "row" : "stack";
  occupied.forEach((slotIndex, index) => {
    const placement = {
      arrangement,
      insertPosition: "before",
    } as const;
    zones.push(
      index === 0
        ? {
            id: `${prefix}-start`,
            label: arrangement === "columns" ? "Left edge" : "Top edge",
            placement,
            position: `${prefix}-start`,
            slotIndex,
          }
        : {
            id: `${prefix}-seam-${index}`,
            label: `Between chat ${index} and chat ${index + 1}`,
            placement,
            position: `${prefix}-seam-${index}`,
            slotIndex,
          },
    );
  });
  const lastSlot = occupied[occupied.length - 1];
  if (lastSlot !== undefined) {
    zones.push({
      id: `${prefix}-end`,
      label: arrangement === "columns" ? "Right edge" : "Bottom edge",
      placement: { arrangement, insertPosition: "after" },
      position: `${prefix}-end`,
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
  bounds?: ChatGridDropBounds,
  sourceSlotIndex?: number,
): ChatGridDropZone | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (bounds && !pointerWithinBounds(bounds, x, y)) return undefined;
  const positions = new Set(zones.map((zone) => zone.position));
  if (!zones.length || positions.size !== zones.length) return undefined;
  const rectangles = new Map<string, DropRectangle>();
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    const position = target.dataset.position;
    if (!position || !positions.has(position)) return undefined;
    const rectangle = target.getBoundingClientRect();
    // A hidden, partial, or stale overlay cannot own the drop. Let the caller
    // use the complete before-paint geometry rather than bias toward whichever
    // old targets happen to remain in the DOM.
    if (!validRectangle(rectangle) || rectangles.has(position))
      return undefined;
    rectangles.set(position, rectangle);
  }
  if (rectangles.size !== zones.length) return undefined;
  return nearestZone(zones, rectangles, x, y, bounds, sourceSlotIndex);
}

/** Resolve a release before React has painted the placement overlay. */
export function chatGridDropZoneBeforePaint(
  zones: ChatGridDropZone[],
  bounds: ChatGridDropBounds,
  x: number,
  y: number,
  sourceSlotIndex?: number,
): ChatGridDropZone | undefined {
  if (!zones.length || !pointerWithinBounds(bounds, x, y)) return undefined;
  const layout = chatGridDropLayout(zones);
  const rectangles = new Map<string, DropRectangle>();
  const { left, top, width, height } = bounds;
  const columns =
    layout === "row" ? zones.length : layout === "full" || layout === "stack" ? 1 : 2;
  const rows =
    layout === "stack" ? zones.length : layout === "positions" ? 2 : 1;
  const tileWidth =
    (width - DROP_OVERLAY_PADDING * 2 - DROP_OVERLAY_GAP * (columns - 1)) /
    columns;
  const tileHeight =
    (height - DROP_OVERLAY_PADDING * 2 - DROP_OVERLAY_GAP * (rows - 1)) /
    rows;
  if (tileWidth <= 0 || tileHeight <= 0) return undefined;
  zones.forEach((zone, index) => {
    const tileLeft =
      left + DROP_OVERLAY_PADDING +
      (index % columns) * (tileWidth + DROP_OVERLAY_GAP);
    const tileTop =
      top + DROP_OVERLAY_PADDING +
      Math.floor(index / columns) * (tileHeight + DROP_OVERLAY_GAP);
    rectangles.set(zone.position, {
      left: tileLeft,
      right: tileLeft + tileWidth,
      top: tileTop,
      bottom: tileTop + tileHeight,
    });
  });
  return nearestZone(zones, rectangles, x, y, bounds, sourceSlotIndex);
}

function validRectangle(rectangle: DropRectangle): boolean {
  return (
    [rectangle.left, rectangle.top, rectangle.right, rectangle.bottom].every(
      Number.isFinite,
    ) &&
    rectangle.right > rectangle.left &&
    rectangle.bottom > rectangle.top
  );
}

function pointerWithinBounds(
  bounds: ChatGridDropBounds,
  x: number,
  y: number,
): boolean {
  const rectangle = {
    left: bounds.left,
    top: bounds.top,
    right: bounds.left + bounds.width,
    bottom: bounds.top + bounds.height,
  };
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    validRectangle(rectangle) &&
    x >= rectangle.left &&
    x <= rectangle.right &&
    y >= rectangle.top &&
    y <= rectangle.bottom
  );
}

function nearestZone(
  zones: ChatGridDropZone[],
  rectangles: Map<string, DropRectangle>,
  x: number,
  y: number,
  bounds?: ChatGridDropBounds,
  sourceSlotIndex?: number,
): ChatGridDropZone | undefined {
  let nearest: ChatGridDropZone | undefined;
  let distance = Infinity;
  // Zone order, rather than DOM query order, breaks exact ties. Hover and a
  // release before paint therefore choose the same side of a gutter or seam.
  for (const zone of zones) {
    const rectangle = rectangles.get(zone.position);
    if (!rectangle || !validRectangle(rectangle)) return undefined;
    const dx = Math.max(rectangle.left - x, 0, x - rectangle.right);
    const dy = Math.max(rectangle.top - y, 0, y - rectangle.bottom);
    const candidateDistance = Math.hypot(dx, dy);
    if (candidateDistance < distance) {
      nearest = zone;
      distance = candidateDistance;
    }
  }
  const layout = chatGridDropLayout(zones);
  if (
    !bounds ||
    sourceSlotIndex === undefined ||
    (layout !== "row" && layout !== "stack")
  ) return nearest;
  const sourceIndex = zones.findIndex(
    (zone) => zone.isSource && zone.slotIndex === sourceSlotIndex,
  );
  if (sourceIndex < 0) return nearest;
  // Keep a release on either original source boundary a cancellation. Away
  // from those seams, the broad tiles own their full visible areas.
  const horizontal = layout === "row";
  const offset = horizontal ? x - bounds.left : y - bounds.top;
  const length = horizontal ? bounds.width : bounds.height;
  const track = (length + ROW_PANE_GAP) / zones.length;
  if ([sourceIndex, sourceIndex + 1].some(
    (boundary) => Math.abs(offset - boundary * track) <= REORDER_CANCEL_HALF_WIDTH,
  )) return zones[sourceIndex];
  return nearest;
}
