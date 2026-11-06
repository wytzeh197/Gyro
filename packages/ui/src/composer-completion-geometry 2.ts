type Bounds = { left: number; right: number; top: number; bottom: number };

/** All inputs and results are viewport pixels, before conversion to CSS zoom. */
export function completionMenuGeometry({
  bounds,
  anchor,
  naturalHeight,
  minimumHeight,
  gap,
  pad = 8,
}: {
  bounds: Bounds;
  anchor: Bounds;
  naturalHeight: number;
  minimumHeight: number;
  gap: number;
  pad?: number;
}):
  | { direction: "up" | "down"; height: number }
  | { direction: "overlay"; height: number; top: number } {
  const above = Math.max(0, anchor.top - bounds.top - pad - gap);
  const below = Math.max(0, bounds.bottom - anchor.bottom - pad - gap);
  const direction = naturalHeight > above && below > above ? "down" : "up";
  const available = direction === "up" ? above : below;
  if (available >= Math.min(minimumHeight, naturalHeight)) {
    return { direction, height: Math.min(naturalHeight, available) };
  }
  // A short split may have no usable space beside the composer. Keep a
  // scrollable overlay in that pane instead of reducing it to a hidden menu.
  const height = Math.min(
    naturalHeight,
    Math.max(0, bounds.bottom - bounds.top - pad * 2),
  );
  const top = Math.max(
    bounds.top + pad,
    Math.min(anchor.top - gap - height, bounds.bottom - pad - height),
  );
  return { direction: "overlay" as const, height, top };
}
