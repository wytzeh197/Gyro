import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./tauri-runtime";
import type { SessionEvent } from "@gyro-dev/ui";
import {
  deriveChatMode,
  deriveSessionGoal,
  deriveSessionPlan,
  withSessionContextEvents,
} from "./session-context-events";

export function deriveSessionContext(
  contextEvents: SessionEvent[],
  recentEvents: SessionEvent[],
  sessionId?: string,
) {
  const events = withSessionContextEvents(contextEvents, recentEvents);
  return {
    plan: deriveSessionPlan(events, sessionId),
    goal: deriveSessionGoal(events, sessionId),
    mode: deriveChatMode(events),
  };
}

export function useDerivedSessionContext(
  eventsBySession: Record<string, SessionEvent[]>,
  sessionId: string | undefined,
  recentEvents: SessionEvent[],
) {
  const contextEvents = eventsBySession[sessionId ?? ""] ?? [];
  return useMemo(
    () => deriveSessionContext(contextEvents, recentEvents, sessionId),
    [contextEvents, recentEvents, sessionId],
  );
}

export function useSessionContextEvents() {
  const [eventsBySession, setEventsBySession] = useState<
    Record<string, SessionEvent[]>
  >({});

  const replace = useCallback((sessionId: string, events: SessionEvent[]) => {
    // A disk read may have started before a live progress event arrived.
    // Merge immutable durable events so that response cannot erase it.
    setEventsBySession((current) => ({
      ...current,
      [sessionId]: withSessionContextEvents(current[sessionId] ?? [], events),
    }));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<SessionEvent>("gyro://session-plan-updated", ({ payload }) => {
      if (disposed || payload.kind !== "plan-updated") return;
      replace(payload.sessionId, [payload]);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [replace]);

  const forget = useCallback((sessionId: string) => {
    setEventsBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const forgetMany = useCallback((sessionIds: Set<string>) => {
    setEventsBySession((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => !sessionIds.has(id)),
      ),
    );
  }, []);

  return { eventsBySession, replace, forget, forgetMany };
}
