import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEvent } from "@gyro-dev/ui";
import {
  createChatAutoRetryController,
  type AutoRetrySchedule,
} from "./chat-auto-retry";

type RetryOptions = {
  enabled: boolean;
  eventsBySessionId: Record<string, SessionEvent[]>;
  sendingSessionIds: string[];
  queueVersion: unknown;
  pauseVersion: number;
  blockedSessionIds: () => ReadonlySet<string>;
  onRetry: (event: SessionEvent) => void;
};

/** Session-owned timers survive pane switches and never change the draft. */
export function useChatAutoRetry(options: RetryOptions) {
  const controllerRef =
    useRef<ReturnType<typeof createChatAutoRetryController>>();
  if (!controllerRef.current) {
    controllerRef.current = createChatAutoRetryController();
  }
  const controller = controllerRef.current;
  const latest = useRef(options);
  latest.current = options;
  const [pending, setPending] = useState<Record<string, AutoRetrySchedule>>({});
  const publish = useCallback((next: Record<string, AutoRetrySchedule>) => {
    setPending((current) => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(current).length &&
        keys.every((key) => current[key]?.retryAt === next[key]?.retryAt)
        ? current
        : next;
    });
  }, []);
  const refresh = useCallback(() => {
    const current = latest.current;
    publish(
      current.enabled
        ? controller.observe(
            current.eventsBySessionId,
            Date.now(),
            current.blockedSessionIds(),
          )
        : {},
    );
  }, [controller, publish]);

  useEffect(refresh, [
    refresh,
    options.enabled,
    options.eventsBySessionId,
    options.sendingSessionIds,
    options.queueVersion,
    options.pauseVersion,
  ]);

  useEffect(() => {
    const deadlines = Object.values(pending).map((retry) => retry.retryAt);
    if (!options.enabled || deadlines.length === 0) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (disposed) return;
      const current = latest.current;
      if (!current.enabled) return;
      const due = controller.takeDue(
        current.eventsBySessionId,
        Date.now(),
        current.blockedSessionIds(),
      );
      // Consume and publish before replaying, including synchronous callbacks.
      refresh();
      due.forEach((event) => current.onRetry(event));
      // If the deadline passed during a still-finishing send, recheck gently.
      // A changed transcript or explicit cancellation will remove this timer.
      if (due.length === 0) timer = setTimeout(tick, 1_000);
    };
    timer = setTimeout(tick, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [controller, options.enabled, pending, refresh]);

  const cancel = useCallback(
    (eventId: string) => {
      controller.cancel(eventId);
      refresh();
    },
    [controller, refresh],
  );
  const cancelSession = useCallback(
    (sessionId: string) => {
      controller.cancelSession(sessionId);
      refresh();
    },
    [controller, refresh],
  );
  return { pending, cancel, cancelSession };
}
