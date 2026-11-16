import { useEffect, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

export function useSessionCreatedEvents(
  setSessions: Dispatch<SetStateAction<Session[]>>,
) {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Session>("gyro://session-created", ({ payload }) => {
      if (disposed) return;
      // Remote creation bypasses this window's create-chat flow. Preserve the
      // current conversation and ignore duplicate notifications.
      setSessions((current) =>
        current.some((session) => session.id === payload.id)
          ? current
          : [payload, ...current],
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setSessions]);
}
