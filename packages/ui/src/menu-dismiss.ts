import { useEffect, useRef, type RefObject } from "react";

type OpenMenu = {
  element: HTMLElement;
  dismiss: () => void;
};
const openMenus: OpenMenu[] = [];

export function dismissOpenMenus() {
  for (const menu of [...openMenus].reverse()) menu.dismiss();
}

export function useOutsidePointerDismiss<T extends HTMLElement>(
  isOpen: boolean,
  onDismiss: () => void,
  triggerRef?: RefObject<HTMLElement | null>,
  onEscapeSubmenu?: () => boolean,
) {
  const ref = useRef<T | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const escapeRef = useRef(onEscapeSubmenu);
  escapeRef.current = onEscapeSubmenu;

  useEffect(() => {
    const element = ref.current;
    if (!isOpen || !element) return;
    const returnFocus =
      triggerRef?.current ??
      (element.querySelector("[aria-haspopup]") as HTMLElement | null) ??
      (document.activeElement as HTMLElement | null);
    // Nested menus stay open together; unrelated overlays never stack.
    for (const menu of [...openMenus]) {
      if (!menu.element.contains(element) && !element.contains(menu.element)) {
        menu.dismiss();
      }
    }
    const menu = { element, dismiss: () => dismissRef.current() };
    openMenus.push(menu);
    const handlePointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (
        path.includes(element) ||
        (triggerRef?.current && path.includes(triggerRef.current))
      )
        return;
      menu.dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || openMenus.at(-1) !== menu) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (escapeRef.current?.()) return;
        menu.dismiss();
        const focusTarget = triggerRef?.current ?? returnFocus;
        if (focusTarget?.isConnected) focusTarget.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (
        !target ||
        target.matches("input, textarea, select, [contenteditable=true]")
      )
        return;
      const items = [
        ...element.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].filter(
        (item) =>
          !item.matches(":disabled, [aria-disabled=true]") &&
          item.getClientRects().length > 0,
      );
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(target);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % items.length
              : current < 0
                ? items.length - 1
                : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      const index = openMenus.indexOf(menu);
      if (index >= 0) openMenus.splice(index, 1);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, triggerRef]);

  return ref;
}
