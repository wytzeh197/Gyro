import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { clippingBounds, popoverViewportRect } from "./composer-popover-bounds";
import { completionMenuGeometry } from "./composer-completion-geometry";

/** Keep slash commands and context completions inside their owning chat pane. */
export function ComposerCompletionMenu({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const position = (event?: Event) => {
      if (
        event?.type === "scroll" &&
        event.target instanceof Node &&
        panel.contains(event.target)
      )
        return;
      const list = panel.querySelector<HTMLElement>(
        ".gyro-composer-slash-list",
      );
      const scrollTop = panel.scrollTop;
      const listScrollTop = list?.scrollTop ?? 0;
      // Return to the CSS anchor before measuring, so resize never adds drift.
      panel.style.top = "";
      panel.style.bottom = "";
      panel.style.maxHeight = "";
      panel.style.maxWidth = "";
      panel.style.translate = "";
      const anchorElement =
        panel.offsetParent instanceof HTMLElement
          ? panel.offsetParent
          : panel.parentElement!;
      const anchor = popoverViewportRect(anchorElement);
      const scaleX = anchor.width / anchorElement.offsetWidth || anchor.zoom;
      const scaleY = anchor.height / anchorElement.offsetHeight || anchor.zoom;
      const bounds = clippingBounds(panel, popoverViewportRect);
      const pad = 8;
      const gap = 8 * scaleY;
      panel.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - pad * 2) / scaleX}px`;
      const naturalHeight = panel.offsetHeight;
      const header = panel.querySelector<HTMLElement>(":scope > header");
      const footer = panel.querySelector<HTMLElement>(":scope > footer");
      const row = panel.querySelector<HTMLElement>("button");
      const listStyle = list ? getComputedStyle(list) : getComputedStyle(panel);
      const minimumHeight =
        (header?.offsetHeight ?? 0) +
        (footer?.offsetHeight ?? 0) +
        (row?.offsetHeight ?? 0) +
        (parseFloat(listStyle.paddingTop) || 0) +
        (parseFloat(listStyle.paddingBottom) || 0) +
        2;
      const placement = completionMenuGeometry({
        bounds,
        anchor,
        naturalHeight: naturalHeight * scaleY,
        minimumHeight: minimumHeight * scaleY,
        gap,
        pad,
      });
      panel.style.top =
        placement.direction === "overlay"
          ? `${(placement.top - anchor.top) / scaleY}px`
          : placement.direction === "down"
            ? "calc(100% + 8px)"
            : "auto";
      panel.style.bottom =
        placement.direction === "up" ? "calc(100% + 8px)" : "auto";
      panel.style.maxHeight = `${placement.height / scaleY}px`;
      const width = panel.offsetWidth * scaleX;
      const naturalLeft = anchor.left + panel.offsetLeft * scaleX;
      const left = Math.min(
        Math.max(naturalLeft, bounds.left + pad),
        bounds.right - pad - width,
      );
      panel.style.translate = `${(left - naturalLeft) / scaleX}px 0`;
      panel.scrollTop = scrollTop;
      if (list) list.scrollTop = listScrollTop;
    };
    position();
    // Context selection stays on the textarea; reveal its option without
    // moving focus when arrows reach a row outside the bounded menu.
    panel
      .querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
    const observer = new ResizeObserver(() => position());
    for (
      let ancestor = panel.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [children]);
  return (
    <div {...props} ref={panelRef}>
      {children}
    </div>
  );
}
