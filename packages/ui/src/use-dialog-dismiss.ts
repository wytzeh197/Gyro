import { useCallback, useEffect, useRef } from "react";
import { hasOpenMenus } from "./menu-dismiss";

const openDialogs: HTMLElement[] = [];

/** Cancel can settle visually; destructive confirmation callbacks remain immediate. */
export function useDialogDismiss<T extends HTMLElement = HTMLDivElement>(
  onDismiss: () => void,
) {
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
    const card =
      root instanceof HTMLDialogElement ? root : root.firstElementChild;
    const cardAnimation =
      card instanceof HTMLElement && card !== root
        ? card.animate(
            [
              { transform: getComputedStyle(card).transform },
              { transform: "translateY(4px) scale(0.99)" },
            ],
            { duration: duration || 0, easing, fill: "forwards" },
          )
        : undefined;
    animations.current = cardAnimation ? [fade, cardAnimation] : [fade];
    root.inert = true;
    fade.finished.then(
      () => callback.current(),
      () => {},
    );
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    openDialogs.push(root);
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[inert], [hidden]") &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
    const focusInside = (last = false) => {
      const items = focusable();
      const target = last ? items.at(-1) : items[0];
      if (target) target.focus({ preventScroll: true });
      else {
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
      }
    };
    // Native modal dialogs already own focus containment and cancel events.
    const isNative = root instanceof HTMLDialogElement;
    if (!isNative && !root.contains(document.activeElement)) focusInside();
    const handleTabKeyDown = (event: KeyboardEvent) => {
      if (isNative || openDialogs.at(-1) !== root || event.defaultPrevented)
        return;
      if (
        event.key === "Tab" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const items = focusable();
        const active = document.activeElement;
        if (
          closing.current ||
          !root.contains(active) ||
          !items.length ||
          (event.shiftKey ? active === items[0] : active === items.at(-1))
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!closing.current) focusInside(event.shiftKey);
        }
      }
    };
    const handleDismissKeyDown = (event: KeyboardEvent) => {
      if (isNative || openDialogs.at(-1) !== root || event.key !== "Escape")
        return;
      // Controls and nested menus get the first decision about Escape.
      if (event.defaultPrevented) {
        event.stopPropagation();
        return;
      }
      if (hasOpenMenus()) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener("keydown", handleTabKeyDown, true);
    document.addEventListener("keydown", handleDismissKeyDown);
    return () => {
      const index = openDialogs.indexOf(root);
      if (index >= 0) openDialogs.splice(index, 1);
      document.removeEventListener("keydown", handleTabKeyDown, true);
      document.removeEventListener("keydown", handleDismissKeyDown);
    };
  }, [dismiss]);

  return { ref, dismiss };
}
