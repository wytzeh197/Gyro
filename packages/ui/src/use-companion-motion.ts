import {
  createContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

const COMPANION_MOTION_MS = 160;

/** Native child views cannot be clipped or faded by the dock's CSS. */
export const CompanionMotionContext = createContext(false);

/** Keep the selected tool alive for its exit, without delaying logical close. */
export function useCompanionPresence<T>(
  current: T | undefined,
  retainExit: boolean,
) {
  const [retained, setRetained] = useState(current);
  const currentRef = useRef(current);
  currentRef.current = current;
  useLayoutEffect(() => {
    if (current !== undefined || !retainExit) setRetained(current);
  }, [current, retainExit]);
  const finishExit = useCallback(() => {
    if (currentRef.current === undefined) setRetained(undefined);
  }, []);
  return { panel: current ?? (retainExit ? retained : undefined), finishExit };
}

/** Width drives the actual grid track; an interrupted animation starts where it is painted. */
export function useCompanionMotion(
  ref: MutableRefObject<HTMLElement | null>,
  open: boolean,
  width: string,
  isResizing: boolean,
  onExitComplete: () => void,
) {
  const [moving, setMoving] = useState(true);
  const previousOpen = useRef<boolean>();
  const interrupted = useRef<{ width: number; opacity: string }>();
  const wasMoving = useRef(false);

  useLayoutEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    dock.inert = !open;
    if (!open && dock.contains(document.activeElement)) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      dock.parentElement
        ?.querySelector<HTMLElement>(
          '.gyro-chat-surface-controls button[aria-label="Show companion"]',
        )
        ?.focus({ preventScroll: true });
    }

    const changed = previousOpen.current !== open;
    const initial = previousOpen.current === undefined;
    previousOpen.current = open;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shouldAnimate = !isResizing && (changed || wasMoving.current);
    const start = interrupted.current ?? {
      width: initial ? 0 : dock.getBoundingClientRect().width,
      opacity: initial ? "0" : getComputedStyle(dock).opacity,
    };
    interrupted.current = undefined;
    const finish = () => {
      wasMoving.current = false;
      setMoving(false);
      if (!open) onExitComplete();
    };
    if (!shouldAnimate || reducedMotion.matches || !dock.animate) {
      finish();
      return;
    }

    wasMoving.current = true;
    setMoving(true);
    // React has already installed the target inline width. Measure it before
    // applying the animation so percentage widths and overlay caps still work.
    const target = open ? dock.getBoundingClientRect().width : 0;
    const computed = getComputedStyle(dock);
    const factor = parseFloat(computed.getPropertyValue("--gyro-motion-factor")) || 1;
    const easing = computed.getPropertyValue("--gyro-premium-ease").trim() || "ease-out";
    const animation = dock.animate(
      [
        { width: `${start.width}px`, opacity: start.opacity },
        { width: `${target}px`, opacity: open ? "1" : "0" },
      ],
      {
        duration: COMPANION_MOTION_MS * factor,
        easing,
        fill: "both",
      },
    );
    let completed = false;
    animation.onfinish = () => {
      completed = true;
      if (open) animation.cancel();
      finish();
    };
    const stopForReducedMotion = () => {
      if (reducedMotion.matches) animation.finish();
    };
    reducedMotion.addEventListener("change", stopForReducedMotion);
    return () => {
      reducedMotion.removeEventListener("change", stopForReducedMotion);
      animation.onfinish = null;
      if (!completed) {
        interrupted.current = {
          width: dock.getBoundingClientRect().width,
          opacity: getComputedStyle(dock).opacity,
        };
      }
      animation.cancel();
    };
  }, [ref, open, width, isResizing, onExitComplete]);

  return moving || !open;
}
