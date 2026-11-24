type Rect = { left: number; right: number; top: number; bottom: number };

function overlaps(a: Rect, b: Rect) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

function rectangle({ left, right, top, bottom }: Rect) {
  return `M${left} ${top}H${right}V${bottom}H${left}Z`;
}

function cutoutPath(bounds: DOMRect, cutouts: DOMRect[]) {
  const paths = [
    rectangle({ left: 0, top: 0, right: bounds.width, bottom: bounds.height }),
  ];
  const holes = cutouts
    .filter((rect) => overlaps(rect, bounds))
    .map((rect) => ({
      left: Math.max(0, rect.left - bounds.left),
      top: Math.max(0, rect.top - bounds.top),
      right: Math.min(bounds.width, rect.right - bounds.left),
      bottom: Math.min(bounds.height, rect.bottom - bounds.top),
    }));
  if (!holes.length) return "";

  // Union rectangles in horizontal bands. Even-odd fill would otherwise
  // repaint the intersection of two overlapping popup cutouts.
  const edges = [
    ...new Set(holes.flatMap(({ top, bottom }) => [top, bottom])),
  ].sort((a, b) => a - b);
  for (let i = 0; i + 1 < edges.length; i++) {
    const top = edges[i]!;
    const bottom = edges[i + 1]!;
    const intervals = holes
      .filter((hole) => hole.top <= top && hole.bottom >= bottom)
      .sort((a, b) => a.left - b.left);
    let merged: Rect | undefined;
    for (const interval of intervals) {
      if (merged && interval.left <= merged.right) {
        merged.right = Math.max(merged.right, interval.right);
      } else {
        if (merged) paths.push(rectangle(merged));
        merged = { left: interval.left, right: interval.right, top, bottom };
      }
    }
    if (merged) paths.push(rectangle(merged));
  }
  return `path(evenodd, "${paths.join("")}")`;
}

/** Update the shared backdrop only while a portaled popup occupies it. */
export function observeGlassOverlays(shell: HTMLElement) {
  const { documentElement, body } = shell.ownerDocument;
  const reducedTransparency = window.matchMedia(
    "(prefers-reduced-transparency: reduce)",
  );
  const property = "--gyro-glass-cutout";
  let frame = 0;
  let marked: HTMLElement[] = [];
  let previous = "";
  const render = () => {
    frame = 0;
    const enabled =
      documentElement.dataset.nativeMaterial === "sidebar" &&
      !reducedTransparency.matches;
    const popups = enabled
      ? [
          ...body.querySelectorAll<HTMLElement>(
            ".gyro-popup[data-open], .gyro-popup[data-ending-style]",
          ),
        ].filter(
          (popup) => !shell.contains(popup) && popup.getClientRects().length,
        )
      : [];
    const rects = popups.map((popup) => popup.getBoundingClientRect());
    const dialogs = popups.length
      ? [...body.querySelectorAll(".gyro-dialog[data-open]")].map((dialog) =>
          dialog.getBoundingClientRect(),
        )
      : [];
    const next = popups.filter((_, index) =>
      [...dialogs, ...rects.slice(0, index)].some((rect) =>
        overlaps(rect, rects[index]!),
      ),
    );
    for (const popup of marked)
      if (!next.includes(popup)) popup.removeAttribute("data-glass-backed");
    for (const popup of next)
      if (!marked.includes(popup)) popup.setAttribute("data-glass-backed", "");
    marked = next;

    const clip = rects.length
      ? cutoutPath(shell.getBoundingClientRect(), rects)
      : "";
    if (clip !== previous) {
      if (clip) shell.style.setProperty(property, clip);
      else shell.style.removeProperty(property);
      previous = clip;
    }
    if (popups.length) schedule();
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(render);
  };
  const observer = new MutationObserver(schedule);
  const updateObservation = () => {
    observer.disconnect();
    if (
      documentElement.dataset.nativeMaterial === "sidebar" &&
      !reducedTransparency.matches
    ) {
      observer.observe(body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-open"],
      });
    }
    schedule();
  };
  const materialObserver = new MutationObserver(updateObservation);
  materialObserver.observe(documentElement, {
    attributes: true,
    attributeFilter: ["data-native-material"],
  });
  reducedTransparency.addEventListener("change", updateObservation);
  updateObservation();
  return () => {
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    materialObserver.disconnect();
    reducedTransparency.removeEventListener("change", updateObservation);
    shell.style.removeProperty(property);
    for (const popup of marked) popup.removeAttribute("data-glass-backed");
  };
}
