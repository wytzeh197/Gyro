import type { TerminalDropEdge } from "./terminal-layout";

export const TERMINAL_SESSION_MIME = "application/x-gyro-terminal";
type Placement = { element: HTMLElement; targetId: string; edge: TerminalDropEdge };
type Drag = { paneId: string; over?: Placement };

let drag: Drag | undefined;
const listeners = new Set<(value: Drag | undefined) => void>();
const drops = new Set<(paneId: string, target: Placement) => void>();
let cancelGesture: (() => void) | undefined;
let clearNativeGesture: (() => void) | undefined;

function notify() {
  for (const listener of listeners) listener(drag);
}

export function subscribeTerminalSessionDrag(listener: (value: Drag | undefined) => void) {
  listeners.add(listener);
  listener(drag);
  return () => { listeners.delete(listener); };
}

export function subscribeTerminalSessionDrop(listener: (paneId: string, target: Placement) => void) {
  drops.add(listener);
  return () => { drops.delete(listener); };
}

export function finishTerminalSessionDrag() {
  clearNativeGesture?.();
  clearNativeGesture = undefined;
  drag = undefined;
  notify();
}

export function terminalSessionPlacement(x: number, y: number): Placement | undefined {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-terminal-session-pane]");
  if (!element || !element.getClientRects().length) return;
  const targetId = element.dataset.terminalSessionPane;
  const bounds = element.getBoundingClientRect();
  if (!targetId || !bounds.width || !bounds.height) return;
  const rx = (x - bounds.left) / bounds.width;
  const ry = (y - bounds.top) / bounds.height;
  const distances = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  const edge = (Object.keys(distances) as TerminalDropEdge[]).reduce(
    (nearest, next) => distances[next] < distances[nearest] ? next : nearest,
    "left",
  );
  return { element, targetId, edge };
}

export function beginTerminalSessionDrag(transfer: DataTransfer, paneId: string) {
  clearNativeGesture?.();
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") finishTerminalSessionDrag();
  };
  window.addEventListener("dragend", finishTerminalSessionDrag);
  window.addEventListener("blur", finishTerminalSessionDrag);
  window.addEventListener("keydown", key, true);
  clearNativeGesture = () => {
    window.removeEventListener("dragend", finishTerminalSessionDrag);
    window.removeEventListener("blur", finishTerminalSessionDrag);
    window.removeEventListener("keydown", key, true);
  };
  transfer.effectAllowed = "move";
  transfer.setData(TERMINAL_SESSION_MIME, paneId);
  drag = { paneId };
  notify();
}

export function hoverTerminalSessionDrag(x: number, y: number) {
  if (!drag) return;
  drag = { paneId: drag.paneId, over: terminalSessionPlacement(x, y) };
  notify();
}

export function dropTerminalSessionDrag(x: number, y: number) {
  const current = drag;
  const target = terminalSessionPlacement(x, y);
  if (current && target && current.paneId !== target.targetId) {
    for (const listener of drops) listener(current.paneId, target);
  }
  finishTerminalSessionDrag();
}

/** Keyboard equivalent of dropping a sidebar session or pane header at an edge. */
export function placeTerminalSessionByKeyboard(event: KeyboardEvent, paneId: string) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const edge = ({
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom",
  } as Record<string, TerminalDropEdge>)[event.key];
  if (!edge) return;
  const candidates = [...document.querySelectorAll<HTMLElement>("[data-terminal-session-pane]")].filter(
    (element) => element.dataset.terminalSessionPane !== paneId && element.getClientRects().length,
  );
  const element = candidates.find((candidate) => candidate.classList.contains("is-active")) ?? candidates[0];
  if (!element) return;
  event.preventDefault();
  event.stopPropagation();
  const targetId = element.dataset.terminalSessionPane!;
  for (const listener of drops) listener(paneId, { element, targetId, edge });
}

/** Match chat dragging: threshold, painted target, pointer capture, and click suppression. */
export function startTerminalSessionPointerDrag(event: PointerEvent, source: HTMLElement, paneId: string) {
  if (event.button !== 0 || event.pointerType !== "mouse" || !event.isPrimary || event.defaultPrevented) return;
  cancelGesture?.();
  const win = source.ownerDocument.defaultView;
  if (!win) return;
  let moved = false;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 6) return;
    if (!moved) {
      moved = true;
      drag = { paneId };
      notify();
      source.setPointerCapture(event.pointerId);
      source.ownerDocument.documentElement.classList.add("gyro-terminal-session-dragging");
    }
    next.preventDefault();
    hoverTerminalSessionDrag(next.clientX, next.clientY);
  };
  const cleanup = () => {
    win.removeEventListener("pointermove", move, true);
    win.removeEventListener("pointerup", up, true);
    win.removeEventListener("pointercancel", cancel, true);
    win.removeEventListener("keydown", key, true);
    win.removeEventListener("blur", cancel);
    source.removeEventListener("lostpointercapture", cancel);
    source.removeEventListener("dragstart", nativeStart);
    source.ownerDocument.documentElement.classList.remove("gyro-terminal-session-dragging");
    if (cancelGesture === cancel) cancelGesture = undefined;
    if (source.hasPointerCapture(event.pointerId)) source.releasePointerCapture(event.pointerId);
    if (moved) {
      // Swallow only this gesture's synthesized click, never keyboard activation.
      const click = (clickEvent: MouseEvent) => {
        if (!clickEvent.detail) return;
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        clear();
      };
      const clear = () => {
        win.removeEventListener("click", click, true);
        win.removeEventListener("pointerdown", clear, true);
        clearTimeout(timer);
      };
      win.addEventListener("click", click, true);
      win.addEventListener("pointerdown", clear, true);
      const timer = setTimeout(clear, 1000);
    }
  };
  const up = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    cleanup();
    if (moved) dropTerminalSessionDrag(next.clientX, next.clientY);
  };
  const cancel = () => {
    cleanup();
    finishTerminalSessionDrag();
  };
  const key = (next: KeyboardEvent) => {
    if (next.key === "Escape") {
      next.preventDefault();
      cancel();
    }
  };
  const nativeStart = (next: DragEvent) => next.preventDefault();
  win.addEventListener("pointermove", move, true);
  win.addEventListener("pointerup", up, true);
  win.addEventListener("pointercancel", cancel, true);
  win.addEventListener("keydown", key, true);
  win.addEventListener("blur", cancel);
  source.addEventListener("lostpointercapture", cancel);
  source.addEventListener("dragstart", nativeStart);
  cancelGesture = cancel;
}
