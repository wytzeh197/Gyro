import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isSplitChatLayout,
  resolveBrowserReveal,
  type BrowserRevealRequest,
  type WorkbenchAction,
} from "@gyro-dev/ui";

/**
 * What the native browser does to the chat's surfaces when a model opens it.
 *
 * The webview is created by the capability dispatcher on the Rust side, so the
 * first the React shell hears of it is a `session-browser-opened` event. That
 * event used to reveal the Browser panel unconditionally, which in a split
 * layout put one chat's page over the transcript of the pane beside it. The
 * page does not need a panel to be usable — an unrevealed browser gets a full
 * desktop viewport on the backend and answers reads, clicks and captures from
 * there — so revealing is a question about the person watching, and this is
 * where it is answered.
 */
export type ModelBrowserRevealContext = Omit<
  BrowserRevealRequest,
  "isUserInitiated"
>;

type SessionBrowserOpened = { sessionId: string; url: string };

export function useModelBrowserReveal(options: {
  activeSessionId?: string;
  dispatch: (action: WorkbenchAction) => void;
  hasMaximizedPane: boolean;
  isBrowserVisible: boolean;
  isTauriRuntime: boolean;
  occupiedPaneCount: number;
}) {
  const {
    activeSessionId,
    dispatch,
    hasMaximizedPane,
    isBrowserVisible,
    isTauriRuntime,
    occupiedPaneCount,
  } = options;
  // A browser opens from a model turn, not from a render. Reading the layout
  // through a ref keeps the listener subscribed across every resize, split and
  // focus change instead of tearing down and missing an in-flight event.
  const contextRef = useRef<ModelBrowserRevealContext>({
    isSplitView: false,
    isBrowserVisible: false,
  });
  contextRef.current = {
    isSplitView: isSplitChatLayout({ occupiedPaneCount, hasMaximizedPane }),
    isBrowserVisible,
  };
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: Promise<(() => void) | undefined> =
      Promise.resolve(undefined);
    try {
      unlisten = listen<SessionBrowserOpened>(
        "session-browser-opened",
        (event) => {
          if (event.payload.sessionId !== activeSessionId) return;
          const send = dispatchRef.current;
          const decision = resolveBrowserReveal({
            isUserInitiated: false,
            ...contextRef.current,
          });
          send({
            type: "browser-navigate",
            url: event.payload.url,
            background: !decision.reveal,
          });
          if (decision.reveal) {
            send({ type: "set-chat-panel", panel: "browser" });
          }
          send({
            type: "browser-status",
            status: "ready",
            message: `Native · ${event.payload.url}`,
            nativeHost: true,
          });
          void invoke<{ title: string } | null>("session_browser_snapshot", {
            sessionId: event.payload.sessionId,
          })
            .then((snapshot) => {
              if (snapshot?.title)
                send({ type: "browser-title", title: snapshot.title });
            })
            .catch(() => {});
        },
      );
    } catch {
      unlisten = Promise.resolve(undefined);
    }
    return () => {
      void unlisten.then((dispose) => dispose?.());
    };
  }, [activeSessionId, isTauriRuntime]);
}
