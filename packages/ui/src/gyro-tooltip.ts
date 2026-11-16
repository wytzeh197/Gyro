/**
 * Gyro tooltips for every `title` attribute.
 *
 * The WebView's native tooltip is a yellow-ish system box that appears after a
 * long, fixed delay and ignores the app's theme. Rather than touching the two
 * hundred-odd `title` props across the UI, one delegated listener takes over:
 * on hover or keyboard focus it lifts the element's `title` (so the system
 * tooltip never shows), renders a themed bubble, and puts the attribute back
 * when the pointer leaves, so selectors and assistive tech still see it.
 */
import "./gyro-tooltip.css";

const SHOW_DELAY_MS = 450;
/** Moving between controls right after a tooltip shows skips the delay. */
const WARM_WINDOW_MS = 400;
const GAP = 6;
const EDGE = 8;

let installed = false;

export function installGyroTooltips(root: Document = document): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;

  const bubble = root.createElement("div");
  bubble.className = "gyro-tooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.id = "gyro-tooltip";
  bubble.hidden = true;
  root.body.appendChild(bubble);

  let target: HTMLElement | SVGElement | null = null;
  let liftedTitle: string | null = null;
  let timer: number | undefined;
  let lastHiddenAt = 0;

  const restore = () => {
    if (target && liftedTitle !== null && !target.hasAttribute("title")) {
      target.setAttribute("title", liftedTitle);
    }
    if (target?.getAttribute("aria-describedby") === bubble.id) {
      target.removeAttribute("aria-describedby");
    }
    liftedTitle = null;
  };

  const hide = () => {
    window.clearTimeout(timer);
    if (!bubble.hidden) lastHiddenAt = performance.now();
    bubble.hidden = true;
    bubble.classList.remove("is-visible");
    restore();
    target = null;
  };

  const place = (element: Element) => {
    const anchor = element.getBoundingClientRect();
    const tip = bubble.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let top = anchor.bottom + GAP;
    let side: "below" | "above" = "below";
    if (top + tip.height > viewportHeight - EDGE && anchor.top - GAP - tip.height >= EDGE) {
      top = anchor.top - GAP - tip.height;
      side = "above";
    }
    let left = anchor.left + anchor.width / 2 - tip.width / 2;
    left = Math.max(EDGE, Math.min(left, viewportWidth - tip.width - EDGE));
    bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    bubble.dataset.side = side;
  };

  const show = (element: HTMLElement | SVGElement, text: string) => {
    bubble.textContent = text;
    bubble.hidden = false;
    place(element);
    bubble.classList.add("is-visible");
    if (!element.hasAttribute("aria-describedby")) {
      element.setAttribute("aria-describedby", bubble.id);
    }
  };

  const begin = (element: HTMLElement | SVGElement, immediate: boolean) => {
    if (element === target) return;
    hide();
    const text = element.getAttribute("title")?.trim();
    if (!text) return;
    target = element;
    liftedTitle = element.getAttribute("title");
    element.removeAttribute("title");
    // Keep the name the title used to give an icon-only control.
    if (
      !element.hasAttribute("aria-label") &&
      !element.hasAttribute("aria-labelledby") &&
      !element.textContent?.trim()
    ) {
      element.setAttribute("aria-label", text);
    }
    const warm = performance.now() - lastHiddenAt < WARM_WINDOW_MS;
    window.clearTimeout(timer);
    timer = window.setTimeout(
      () => {
        if (target === element) show(element, text);
      },
      immediate || warm ? 0 : SHOW_DELAY_MS,
    );
  };

  const titled = (node: EventTarget | null) =>
    node instanceof Element
      ? (node.closest("[title]") as HTMLElement | SVGElement | null)
      : null;

  const onOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const element = titled(event.target);
    if (element) begin(element, false);
    else if (target && !target.contains(event.target as Node)) hide();
  };
  const onOut = (event: PointerEvent) => {
    if (!target) return;
    const next = event.relatedTarget as Node | null;
    if (next && target.contains(next)) return;
    hide();
  };
  const onFocus = (event: FocusEvent) => {
    const element = titled(event.target);
    if (element && (event.target as Element).matches?.(":focus-visible")) {
      begin(element, false);
    }
  };
  const onBlur = () => {
    if (target) hide();
  };

  root.addEventListener("pointerover", onOver, true);
  root.addEventListener("pointerout", onOut, true);
  root.addEventListener("pointerdown", hide, true);
  root.addEventListener("keydown", hide, true);
  root.addEventListener("wheel", hide, { capture: true, passive: true });
  root.addEventListener("focusin", onFocus, true);
  root.addEventListener("focusout", onBlur, true);
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);

  return () => {
    hide();
    root.removeEventListener("pointerover", onOver, true);
    root.removeEventListener("pointerout", onOut, true);
    root.removeEventListener("pointerdown", hide, true);
    root.removeEventListener("keydown", hide, true);
    root.removeEventListener("wheel", hide, true);
    root.removeEventListener("focusin", onFocus, true);
    root.removeEventListener("focusout", onBlur, true);
    window.removeEventListener("blur", hide);
    window.removeEventListener("resize", hide);
    bubble.remove();
    installed = false;
  };
}
