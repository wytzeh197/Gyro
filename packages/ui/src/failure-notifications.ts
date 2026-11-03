import type { Notification, NotificationKind } from "./types";

const FAILURE_KINDS: ReadonlySet<NotificationKind> = new Set([
  "command-failed",
  "browser-failed",
]);
const MAX_STORED_NOTIFICATIONS = 12;
const MAX_VISIBLE_FAILURES = 3;

/** The failures the shell shows, newest first; older ones wait their turn. */
export function visibleFailureNotifications(
  notifications: Notification[],
): Notification[] {
  return notifications
    .filter(
      (notification) =>
        !notification.read && FAILURE_KINDS.has(notification.kind),
    )
    .slice(0, MAX_VISIBLE_FAILURES);
}

/** A failure that repeats while still unread replaces itself, so a retry loop
 * cannot fill the notice lane or push other failures out of the list. */
export function addNotification(
  notifications: Notification[],
  notification: Notification,
): Notification[] {
  return [
    notification,
    ...notifications.filter(
      (existing) =>
        existing.read ||
        existing.kind !== notification.kind ||
        existing.title !== notification.title ||
        existing.detail !== notification.detail,
    ),
  ].slice(0, MAX_STORED_NOTIFICATIONS);
}
