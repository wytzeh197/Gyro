import { useEffect, type Dispatch } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BrowserViewportMode,
  BrowserViewportState,
  WorkbenchAction,
} from "@gyro-dev/ui";
import { sessionBrowserNative } from "./session-browser-native";

export function useSessionBrowserEvents(dispatch: Dispatch<WorkbenchAction>) {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisten = listen<{
      kind?: string;
      sessionId: string;
      resourceId?: string;
    }>("session-browser-event", ({ payload }) => {
      if (disposed) return;
      const send = (action: WorkbenchAction) =>
        dispatch({
          type: "browser-session",
          sessionId: payload.sessionId,
          action,
        });
      const kind = payload.kind;
      if (
        kind !== "loading" &&
        kind !== "loaded" &&
        kind !== "failed" &&
        kind !== "title" &&
        kind !== "viewport"
      )
        return;
      void sessionBrowserNative.observe(
        payload.sessionId,
        payload.resourceId,
        kind,
        (snapshot) => {
          if (disposed) return;
          // The event may belong to a previous navigation in this resource.
          // Publish one current snapshot, including its real loading state.
          send({ type: "browser-native-state", ...snapshot });
        },
      );
    }).catch(() => undefined);
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose?.());
    };
  }, [dispatch]);
}

export async function changeSessionBrowserViewport(
  sessionId: string,
  mode: BrowserViewportMode,
  hasPage: boolean,
  dispatch: Dispatch<WorkbenchAction>,
  onError: (error: unknown) => void,
) {
  const send = (action: WorkbenchAction) =>
    dispatch({ type: "browser-session", sessionId, action });
  if (!isTauri() || !hasPage) {
    send({ type: "browser-device", device: mode });
    return;
  }
  await sessionBrowserNative.run(
    sessionId,
    () =>
      invoke<{ viewport: BrowserViewportState }>(
        "session_browser_set_viewport",
        {
          sessionId,
          request: { mode },
        },
      ),
    (snapshot) =>
      send({ type: "browser-viewport", viewport: snapshot.viewport }),
    onError,
  );
}
