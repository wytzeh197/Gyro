import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, RefObject } from "react";
import type { Notification, NotificationKind } from "./types";

/*
 * In-app toasts for workbench notifications.
 *
 * Only notifications raised after this window mounted are shown, so a restart
 * never replays yesterday's errors. The generic "terminal" kind is the app's
 * confirmation chatter ("Message sending", "Composer action", …) and stays in
 * the notification list without interrupting.
 */

type ToastTone = "danger" | "warn" | "success" | "neutral";

const TOAST_TONE: Record<NotificationKind, ToastTone | null> = {
  "command-failed": "danger",
  "browser-failed": "danger",
  approval: "warn",
  "tests-passed": "success",
  "diff-ready": "success",
  update: "neutral",
  provider: "neutral",
  "provider-ready": "success",
  terminal: null,
};

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 5000;
/** Space kept between a lifted stack and the composer under it. */
const TOAST_GAP = 8;

export function toastTone(kind: NotificationKind): ToastTone | null {
  return TOAST_TONE[kind] ?? null;
}

const isConnectingToast = (notification: Notification) =>
  notification.kind === "provider" &&
  /^(Connecting provider|Checking Codex sign-in)$/.test(notification.title);

export function visibleToasts(
  notifications: Notification[],
  mountedAt: number,
): Notification[] {
  // A provider result replaces its "Connecting provider" toast. The list is
  // newest first, so a connecting toast after the first result is stale.
  const firstResult = notifications.findIndex(
    (notification) =>
      !notification.read &&
      (notification.kind === "provider-ready" ||
        notification.kind === "approval"),
  );
  return notifications
    .filter(
      (notification, index) =>
        !notification.read &&
        toastTone(notification.kind) !== null &&
        Date.parse(notification.createdAt) >= mountedAt &&
        !(
          firstResult >= 0 &&
          index > firstResult &&
          isConnectingToast(notification)
        ),
    )
    .slice(0, MAX_VISIBLE)
    .reverse();
}

export function ToastStack({
  notifications,
  onDismiss,
}: {
  notifications: Notification[];
  onDismiss?: (id: string) => void;
}) {
  const [mountedAt] = useState(() => Date.now() - 1000);
  const toasts = visibleToasts(notifications, mountedAt);
  const stackRef = useRef<HTMLElement>(null);
  const modal = useOpenModal();
  const offset = useComposerClearance(
    stackRef,
    toasts.map((toast) => toast.id).join(" "),
    modal,
  );
  if (!onDismiss) return null;
  const stack = (
    <section
      aria-label="Notifications"
      className="gyro-toast-stack"
      ref={stackRef}
      style={
        offset
          ? ({ "--gyro-toast-offset": `${offset}px` } as CSSProperties)
          : undefined
      }
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} notification={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
  return modal ? createPortal(stack, modal) : stack;
}

/*
 * A modal <dialog> sits in the browser's top layer and makes everything
 * outside it inert, so no z-index lifts the stack over it. While one is open
 * the stack moves inside it, where it stays readable and dismissible.
 */
function useOpenModal() {
  const [modal, setModal] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    const find = () => {
      const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      setModal(
        [...open].reverse().find((dialog) => dialog.matches(":modal")) ?? null,
      );
    };
    find();
    // Dialogs portal to <body>; showModal() and close() flip `open`.
    const mounts = new MutationObserver(find);
    const toggles = new MutationObserver(find);
    mounts.observe(document.body, { childList: true });
    toggles.observe(document.body, { attributeFilter: ["open"], subtree: true });
    return () => {
      mounts.disconnect();
      toggles.disconnect();
    };
  }, []);
  return modal;
}

/*
 * The stack's corner is where the chat composer keeps its Send button and
 * model chip, and warn/danger toasts stay until dismissed, so they swallowed
 * those clicks. When a composer would sit under the stack, lift the stack
 * clear of it; the offset follows the composer as it grows.
 */
function useComposerClearance(
  stackRef: RefObject<HTMLElement | null>,
  toastKey: string,
  // Portalling into a modal remounts the stack, so measure the new element.
  modal: HTMLDialogElement | null,
) {
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const update = (next: number) => {
      offsetRef.current = next;
      setOffset(next);
    };
    if (!stack || !toastKey) {
      update(0);
      return undefined;
    }
    const composers = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(".gyro-composer-shell"),
      );
    const measure = () => {
      // The stack's box without the current lift.
      const rect = stack.getBoundingClientRect();
      const top = rect.top + offsetRef.current;
      const bottom = rect.bottom + offsetRef.current;
      let next = 0;
      for (const composer of composers()) {
        const box = composer.getBoundingClientRect();
        if (
          box.width > 0 &&
          box.right > rect.left &&
          box.left < rect.right &&
          box.bottom > top &&
          box.top < bottom
        ) {
          next = Math.max(next, Math.ceil(bottom - box.top + TOAST_GAP));
        }
      }
      if (next !== offsetRef.current) update(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const composer of composers()) observer.observe(composer);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stackRef, toastKey, modal]);
  return offset;
}

function Toast({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: (id: string) => void;
}) {
  const tone = toastTone(notification.kind) ?? "neutral";
  const persistent = tone === "danger" || tone === "warn";
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (persistent || paused) return undefined;
    const timer = window.setTimeout(
      () => dismissRef.current(notification.id),
      AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [notification.id, paused, persistent]);

  const detail = notification.detail.trim();
  return (
    <div
      className={`gyro-toast is-${tone}`}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role={persistent ? "alert" : "status"}
    >
      <span aria-hidden="true" className="gyro-dot" data-tone={tone} />
      <div className="gyro-toast-copy">
        <strong>{notification.title}</strong>
        {detail && detail !== notification.title ? (
          <span title={detail}>{detail}</span>
        ) : null}
      </div>
      <button
        aria-label={`Dismiss ${notification.title}`}
        className="gyro-icon-button is-small"
        onClick={() => onDismiss(notification.id)}
        type="button"
      >
        <X size={14} />
      </button>
    </div>
  );
}
