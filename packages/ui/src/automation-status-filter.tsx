import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Segmented, SelectMenu, type ControlSize } from "./primitives";
import type { Automation } from "./types.ts";

export type AutomationStatusFilterValue = Automation["status"] | "";

const automationStatusFilters: Array<{
  value: AutomationStatusFilterValue;
  label: string;
}> = [
  { value: "", label: "All" },
  { value: "current", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
];

const px = (value: string) => Number.parseFloat(value) || 0;

/** The width the segments need on one line: buttons, gaps, padding, border. */
function segmentedWidth(segmented: HTMLElement) {
  const style = getComputedStyle(segmented);
  const buttons = Array.from(segmented.children);
  return (
    buttons.reduce(
      (width, button) => width + button.getBoundingClientRect().width,
      0,
    ) +
    px(style.columnGap) * Math.max(0, buttons.length - 1) +
    px(style.paddingLeft) +
    px(style.paddingRight) +
    px(style.borderLeftWidth) +
    px(style.borderRightWidth)
  );
}

/** The filter control (segments or menu) rendered in the list column. */
const filterIn = (container: HTMLElement | null) =>
  container?.querySelector<HTMLElement>(":scope > .gyro-scheduled-filters");

/**
 * The automation status filter. It is a segmented row while the list column
 * has room for every segment on one line, and the same filter as a menu when
 * the column is narrower than that (beside an open panel in a small window).
 */
export function AutomationStatusFilter({
  containerRef,
  size = "medium",
  value,
  onChange,
}: {
  /** The list column; its content width decides between segments and menu. */
  containerRef: RefObject<HTMLElement>;
  size?: ControlSize;
  value: AutomationStatusFilterValue;
  onChange: (value: AutomationStatusFilterValue) => void;
}) {
  const [asMenu, setAsMenu] = useState(false);
  // Measured one-line width per size, kept while the menu stands in for it.
  const segmentsWidth = useRef<Partial<Record<ControlSize, number>>>({});
  // Swapping controls unmounts the focused one; this carries focus across.
  const refocus = useRef(false);
  // Runs before the measuring effect, so a swap that is undone in the same
  // commit still hands focus on to whichever control ends up rendered.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const filter = filterIn(containerRef.current);
    (asMenu
      ? filter?.querySelector<HTMLElement>(":scope > button")
      : filter?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        filter?.querySelector<HTMLElement>("button")
    )?.focus();
  }, [asMenu, containerRef]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const swap = (next: boolean) => {
      if (next === asMenu) return;
      if (filterIn(container)?.contains(document.activeElement)) {
        refocus.current = true;
      }
      setAsMenu(next);
    };
    const measure = () => {
      const segmented = container.querySelector<HTMLElement>(
        ":scope > .gyro-segmented.gyro-scheduled-filters",
      );
      // Segments that already wrap to a second row do not fit, whatever the
      // rounded widths below say.
      let wraps = false;
      if (segmented && segmented.offsetParent !== null) {
        segmentsWidth.current[size] = segmentedWidth(segmented);
        const first = segmented.firstElementChild as HTMLElement | null;
        const last = segmented.lastElementChild as HTMLElement | null;
        wraps = Boolean(first && last && last.offsetTop > first.offsetTop);
      }
      const needed = segmentsWidth.current[size] ?? 0;
      const style = getComputedStyle(container);
      const available =
        container.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
      // A hidden column (clientWidth 0) keeps its current control.
      if (!container.clientWidth) return;
      // No one-line width for this size yet (the menu was chosen at the other
      // size): show the segments so they get measured. If they do not fit,
      // the next pass swaps back to the menu before paint.
      if (!needed) return swap(false);
      // Going back to segments needs a little spare room, so a scrollbar that
      // appears or disappears with the switch cannot flip it back and forth.
      swap(asMenu ? needed > available - 16 : wraps || needed > available);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [asMenu, containerRef, size]);

  return asMenu ? (
    <SelectMenu
      className="gyro-scheduled-filters"
      label="Status"
      onChange={(next) => onChange(next as AutomationStatusFilterValue)}
      options={automationStatusFilters}
      showLabel
      size="small"
      value={value}
    />
  ) : (
    <Segmented
      className="gyro-scheduled-filters"
      label="Automation status"
      onChange={onChange}
      options={automationStatusFilters}
      size={size}
      value={value}
    />
  );
}
