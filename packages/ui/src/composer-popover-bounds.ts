/// The rectangle a popover actually has to stay inside.
///
/// An overflow-clipped ancestor, not the viewport, is what cuts a flyout off:
/// the Workspace AI sidebar panel is `overflow: hidden`, so anything the
/// composer opens past its right edge is simply not drawn. Walk up to the
/// nearest such ancestor and use it; fall back to the viewport when the
/// composer really does own the full width.
export function clippingBounds(element: HTMLElement) {
  const viewport = {
    left: 0,
    right: window.innerWidth,
    top: 0,
    bottom: window.innerHeight,
  };
  const chatPane = element.closest<HTMLElement>(".gyro-chat-surface.is-tiled");
  if (chatPane) {
    const rect = chatPane.getBoundingClientRect();
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
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
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
