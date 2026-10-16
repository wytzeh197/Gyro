let clientRectsIncludeZoom: boolean | undefined;

/** Older WebKit reports unzoomed rectangles despite viewport-scaled pointer coordinates. */
export function popoverViewportRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (clientRectsIncludeZoom === undefined) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:20px;height:20px;zoom:2;visibility:hidden;pointer-events:none";
    document.body.append(probe);
    clientRectsIncludeZoom = probe.getBoundingClientRect().width > 30;
    probe.remove();
  }
  let zoom = 1;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const factor = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  const scale = clientRectsIncludeZoom ? 1 : zoom;
  return {
    left: rect.left * scale,
    right: rect.right * scale,
    top: rect.top * scale,
    bottom: rect.bottom * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    zoom,
  };
}

/// The rectangle a popover actually has to stay inside.
///
/// An overflow-clipped ancestor, not the viewport, is what cuts a flyout off:
/// the Workspace AI sidebar panel is `overflow: hidden`, so anything the
/// composer opens past its right edge is simply not drawn. Walk up to the
/// nearest such ancestor and use it; fall back to the viewport when the
/// composer really does own the full width.
export function clippingBounds(
  element: HTMLElement,
  rectFor: (
    node: HTMLElement,
  ) => Pick<DOMRect, "left" | "right" | "top" | "bottom"> = (node) =>
    node.getBoundingClientRect(),
) {
  const viewport = {
    left: 0,
    right: window.innerWidth,
    top: 0,
    bottom: window.innerHeight,
  };
  const chatPane = element.closest<HTMLElement>(".gyro-chat-surface.is-tiled");
  if (chatPane) {
    const rect = rectFor(chatPane);
    viewport.left = Math.max(viewport.left, rect.left);
    viewport.right = Math.min(viewport.right, rect.right);
    viewport.top = Math.max(viewport.top, rect.top);
    viewport.bottom = Math.min(viewport.bottom, rect.bottom);
  }
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const style = window.getComputedStyle(node);
    const clips = [style.overflowX, style.overflowY].some(
      (value) => value !== "visible",
    );
    if (!clips) {
      continue;
    }
    const rect = rectFor(node);
    if (rect.right === rect.left || rect.bottom === rect.top) {
      continue;
    }
    return {
      left: Math.max(viewport.left, rect.left),
      right: Math.min(viewport.right, rect.right),
      top: Math.max(viewport.top, rect.top),
      bottom: Math.min(viewport.bottom, rect.bottom),
    };
  }
  return viewport;
}
