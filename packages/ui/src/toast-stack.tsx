import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  terminal: null,
};

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 5000;

export function toastTone(kind: NotificationKind): ToastTone | null {
  return TOAST_TONE[kind] ?? null;
}

export function visibleToasts(
  notifications: Notification[],
  mountedAt: number,
): Notification[] {
  return notifications
    .filter(
      (notification) =>
        !notification.read &&
        toastTone(notification.kind) !== null &&
        Date.parse(notification.createdAt) >= mountedAt,
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
  if (!onDismiss) return null;
  return (
    <section aria-label="Notifications" className="gyro-toast-stack">
      {toasts.map((toast) => (
        <Toast key={toast.id} notification={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
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
