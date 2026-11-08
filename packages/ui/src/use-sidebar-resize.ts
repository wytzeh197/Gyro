import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const KEYBOARD_STEP = 16;

type ActiveDrag = {
  animationFrame?: number;
  pendingWidth: number;
  pointerId: number;
  startWidth: number;
  startX: number;
};

export type SidebarResizeOptions = {
  /** Element whose inline style receives `cssVariable` while dragging. */
  targetRef: RefObject<HTMLElement | null>;
  cssVariable: `--${string}`;
  /** Saved width; undefined means "use the responsive default". */
  savedWidth?: number;
  /** Width the sidebar has when nothing is saved, for the current window. */
  defaultWidth: (viewportWidth: number) => number;
  minimumWidth: (viewportWidth: number) => number;
  maximumWidth: (viewportWidth: number) => number;
  /** Called once per finished gesture. undefined clears the saved width. */
  onCommit?: (width?: number) => void;
};

/**
 * Drag, keyboard and double-click handling for a vertical sidebar edge.
 *
 * Moves write the CSS variable straight to `targetRef` once per frame so the
 * layout follows the pointer without re-rendering the app; the width is
 * committed only when the gesture ends. A saved width wider than the current
 * window allows is shown clamped but kept, so widening the window restores it.
 */
export function useSidebarResize({
  targetRef,
  cssVariable,
  savedWidth,
  defaultWidth,
  minimumWidth,
  maximumWidth,
  onCommit,
}: SidebarResizeOptions) {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<ActiveDrag | undefined>(undefined);

  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(
    () => () => {
      const frame = dragRef.current?.animationFrame;
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
    [],
  );

  const resting = defaultWidth(viewportWidth);
  const maximum = Math.max(resting, maximumWidth(viewportWidth));
  const minimum = Math.min(resting, minimumWidth(viewportWidth));
  const clamp = useCallback(
    (width: number) => Math.round(Math.min(maximum, Math.max(minimum, width))),
    [maximum, minimum],
  );
  const width = savedWidth === undefined ? resting : clamp(savedWidth);

  const commit = useCallback(
    (next: number) => onCommit?.(next === resting ? undefined : next),
    [onCommit, resting],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pendingWidth: width,
        pointerId: event.pointerId,
        startWidth: width,
        startX: event.clientX,
      };
      targetRef.current?.style.setProperty(cssVariable, `${width}px`);
      setIsResizing(true);
    },
    [cssVariable, targetRef, width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.pendingWidth = clamp(drag.startWidth + event.clientX - drag.startX);
      if (drag.animationFrame !== undefined) return;
      drag.animationFrame = requestAnimationFrame(() => {
        drag.animationFrame = undefined;
        targetRef.current?.style.setProperty(
          cssVariable,
          `${drag.pendingWidth}px`,
        );
      });
    },
    [clamp, cssVariable, targetRef],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag.animationFrame !== undefined) {
        cancelAnimationFrame(drag.animationFrame);
      }
      dragRef.current = undefined;
      targetRef.current?.style.setProperty(
        cssVariable,
        `${drag.pendingWidth}px`,
      );
      setIsResizing(false);
      // A plain click (no movement) leaves the saved width untouched, so the
      // first click of a double-click never pins the current default.
      if (drag.pendingWidth !== drag.startWidth) commit(drag.pendingWidth);
    },
    [commit, cssVariable, targetRef],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      let next: number | undefined;
      if (event.key === "ArrowLeft") next = width - KEYBOARD_STEP;
      else if (event.key === "ArrowRight") next = width + KEYBOARD_STEP;
      else if (event.key === "Home") next = minimum;
      else if (event.key === "End") next = maximum;
      if (next === undefined) return;
      event.preventDefault();
      const clamped = clamp(next);
      targetRef.current?.style.setProperty(cssVariable, `${clamped}px`);
      commit(clamped);
    },
    [clamp, commit, cssVariable, maximum, minimum, targetRef, width],
  );

  const onDoubleClick = useCallback(() => {
    targetRef.current?.style.setProperty(cssVariable, `${resting}px`);
    onCommit?.(undefined);
  }, [cssVariable, onCommit, resting, targetRef]);

  return {
    width,
    isCustomized: savedWidth !== undefined,
    isResizing,
    handleProps: {
      "aria-orientation": "vertical" as const,
      "aria-valuemax": maximum,
      "aria-valuemin": minimum,
      "aria-valuenow": width,
      onDoubleClick,
      onKeyDown,
      onLostPointerCapture: endDrag,
      onPointerCancel: endDrag,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      role: "separator" as const,
      tabIndex: 0,
    },
  };
}
