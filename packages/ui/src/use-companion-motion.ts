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
    let completed = false;
    let animation: Animation | undefined;
    let frame: number | undefined;
    let deadline: number | undefined;
    const finish = () => {
      if (completed) return;
      completed = true;
      window.clearTimeout(deadline);
      if (frame !== undefined) cancelAnimationFrame(frame);
      // A missed/cancelled WebKit animation callback must not retain its
      // zero-width fill or keep the native browser hidden indefinitely.
      animation?.cancel();
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
    const computed = getComputedStyle(dock);
    const factor =
      parseFloat(computed.getPropertyValue("--gyro-motion-factor")) || 1;
    const easing =
      computed.getPropertyValue("--gyro-premium-ease").trim() || "ease-out";
    const duration = COMPANION_MOTION_MS * factor;
    const begin = () => {
      frame = undefined;
      if (completed) return;
      // The shared portal's parent layout effect attaches/reveals its rail
      // after this child effect. Wait one frame before measuring that case.
      const target = open ? dock.getBoundingClientRect().width : 0;
      if (open && (!dock.isConnected || target <= 0)) {
        finish();
        return;
      }
      animation = dock.animate(
        [
          { width: `${start.width}px`, opacity: start.opacity },
          { width: `${target}px`, opacity: open ? "1" : "0" },
        ],
        { duration, easing, fill: "both" },
      );
      animation.onfinish = finish;
      animation.oncancel = finish;
    };
    deadline = window.setTimeout(finish, duration + 100);
    if (open && (!dock.isConnected || dock.getBoundingClientRect().width <= 0))
      frame = requestAnimationFrame(begin);
    else begin();
    const stopForReducedMotion = () => {
      if (reducedMotion.matches) finish();
    };
    reducedMotion.addEventListener("change", stopForReducedMotion);
    return () => {
      reducedMotion.removeEventListener("change", stopForReducedMotion);
      window.clearTimeout(deadline);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (animation) {
        animation.onfinish = null;
        animation.oncancel = null;
      }
      if (!completed) {
        interrupted.current = {
          width: dock.getBoundingClientRect().width,
          opacity: getComputedStyle(dock).opacity,
        };
      }
      completed = true;
      animation?.cancel();
    };
  }, [ref, open, width, isResizing, onExitComplete]);

  return moving || !open;
}
