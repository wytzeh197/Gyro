import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Retain detail content only for its short exit; reverse from the current frame. */
export function MotionDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const previousRoot = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (open && !present) {
      setPresent(true);
      return;
    }
    const root = ref.current;
    if (!root) {
      previousRoot.current = null;
      return;
    }
    const entering = open && previousRoot.current !== root;
    previousRoot.current = root;
    root.inert = !open;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      root.style.height = "";
      root.style.opacity = "";
      if (!open) setPresent(false);
    };
    if (media.matches || !root.animate) {
      finish();
      return;
    }
    const from = root.getBoundingClientRect().height;
    const opacity = getComputedStyle(root).opacity;
    // Store the current painted height before cancelling an interrupted animation.
    root.style.height = `${from}px`;
    root.style.opacity = opacity;
    root.getAnimations().forEach((animation) => animation.cancel());
    const factor = parseFloat(getComputedStyle(root).getPropertyValue("--gyro-motion-factor")) || 1;
    const easing = getComputedStyle(root).getPropertyValue("--gyro-premium-ease").trim() || "ease-out";
    const animation = root.animate([
      { height: `${entering ? 0 : from}px`, opacity: entering ? 0 : opacity },
      { height: `${open ? root.scrollHeight : 0}px`, opacity: open ? 1 : 0 },
    ], { duration: 130 * factor, easing, fill: "forwards" });
    const settle = () => {
      finish();
      animation.cancel();
    };
    animation.finished.then(settle, () => {});
    const reduce = () => { if (media.matches) animation.finish(); };
    media.addEventListener("change", reduce);
    return () => {
      media.removeEventListener("change", reduce);
      // Preserve the visual frame before a reversal; the next effect measures it.
      root.style.height = `${root.getBoundingClientRect().height}px`;
      root.style.opacity = getComputedStyle(root).opacity;
      animation.cancel();
    };
  }, [open, present]);
  return present ? (
    <div ref={ref} className="gyro-motion-disclosure" aria-hidden={!open || undefined} style={{ overflow: "hidden" }}>
      {children}
    </div>
  ) : null;
}
