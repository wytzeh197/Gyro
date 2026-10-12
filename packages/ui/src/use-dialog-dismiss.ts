import { useCallback, useEffect, useRef } from "react";

/** Cancel can settle visually; destructive confirmation callbacks remain immediate. */
export function useDialogDismiss<T extends HTMLElement = HTMLDivElement>(onDismiss: () => void) {
  const ref = useRef<T>(null);
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
    // Settle the card as well as the scrim, continuing from interrupted entry.
    const card = root instanceof HTMLDialogElement ? root : root.firstElementChild;
    const cardAnimation = card instanceof HTMLElement && card !== root
      ? card.animate([
          { transform: getComputedStyle(card).transform },
          { transform: "translateY(4px) scale(0.99)" },
        ], { duration: duration || 0, easing, fill: "forwards" })
      : undefined;
    animations.current = cardAnimation ? [fade, cardAnimation] : [fade];
    root.inert = true;
    fade.finished.then(
      () => callback.current(),
      () => {},
    );
  }, []);

  return { ref, dismiss };
}
