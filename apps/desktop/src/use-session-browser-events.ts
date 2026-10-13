import { useEffect, type Dispatch } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BrowserViewportMode,
  BrowserViewportState,
  WorkbenchAction,
} from "@gyro-dev/ui";

export function useSessionBrowserEvents(dispatch: Dispatch<WorkbenchAction>) {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{
      kind?: string;
      sessionId: string;
      title?: string;
      url?: string;
      viewport?: BrowserViewportState;
    }>("session-browser-event", ({ payload }) => {
      const send = (action: WorkbenchAction) =>
        dispatch({
          type: "browser-session",
          sessionId: payload.sessionId,
          action,
        });
      if (payload.kind === "loaded" && payload.url)
        send({ type: "browser-loaded", url: payload.url });
      if (payload.kind === "title" && payload.title !== undefined)
        send({ type: "browser-title", title: payload.title });
      if (payload.viewport)
        send({ type: "browser-viewport", viewport: payload.viewport });
    }).catch(() => undefined);
    return () => {
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
  try {
    const snapshot = await invoke<{ viewport: BrowserViewportState }>(
      "session_browser_set_viewport",
      {
        sessionId,
        request: { mode },
      },
    );
    send({ type: "browser-viewport", viewport: snapshot.viewport });
  } catch (error) {
    onError(error);
  }
}
