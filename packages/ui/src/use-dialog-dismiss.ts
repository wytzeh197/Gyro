import { useCallback, useEffect, useRef } from "react";

/** Cancel can settle visually; destructive confirmation callbacks remain immediate. */
export function useDialogDismiss(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onDismiss);
  const animations = useRef<Animation[]>([]);
  const closing = useRef(false);
  const previousFocusRef = useRef(document.activeElement);
  callback.current = onDismiss;

  useEffect(() => {
    const previousFocus = previousFocusRef.current;
    const root = ref.current;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      if (media.matches)
        animations.current.forEach((animation) => animation.finish());
    };
    media.addEventListener("change", finish);
    return () => {
      media.removeEventListener("change", finish);
      animations.current.forEach((animation) => animation.cancel());
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        (document.activeElement === document.body ||
          root?.contains(document.activeElement))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const dismiss = useCallback(() => {
    if (closing.current) return;
    const root = ref.current;
    if (
      !root ||
      !root.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      callback.current();
      return;
    }
    closing.current = true;
    // The backdrop's computed duration already includes the user's speed factor.
    const cssDuration = getComputedStyle(root)
      .animationDuration.split(",")[0]!
      .trim();
    const duration =
      parseFloat(cssDuration) * (cssDuration.endsWith("ms") ? 1 : 1000);
    const easing = getComputedStyle(root)
      .getPropertyValue("--gyro-premium-ease")
      .trim();
    const opacity = getComputedStyle(root).opacity;
    const fade = root.animate([{ opacity }, { opacity: 0 }], {
      duration: duration || 0,
      easing,
      fill: "forwards",
    });
    animations.current = [fade];
    root.inert = true;
    fade.finished.then(
      () => callback.current(),
      () => {},
    );
  }, []);

  return { ref, dismiss };
}
