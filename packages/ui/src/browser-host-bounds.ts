type BrowserHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Keep a native child aligned even when CSS moves its host without resizing it. */
export function observeBrowserHostBounds(
  element: HTMLElement,
  onBoundsChange: (bounds: BrowserHostBounds | null) => void,
): () => void {
  let frame = 0;
  let lastBounds = "";
  const report = () => {
    const rect = element.getBoundingClientRect();
    const hidden =
      rect.width < 2 ||
      rect.height < 2 ||
      getComputedStyle(element).visibility === "hidden";
    const key = hidden
      ? "hidden"
      : `${rect.left}:${rect.top}:${rect.width}:${rect.height}`;
    if (key !== lastBounds) {
      lastBounds = key;
      onBoundsChange(
        hidden
          ? null
          : {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            },
      );
    }
    // ResizeObserver misses position-only changes (pane swaps, sidebar
    // transitions and transforms). Native children do not follow CSS, so
    // track the actual rectangle, sending IPC only when it changes.
    frame = requestAnimationFrame(report);
  };
  report();
  return () => {
    cancelAnimationFrame(frame);
    onBoundsChange(null);
  };
}
