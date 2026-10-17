import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  dictationAccessError,
  setSharedDictation,
  type DictationController,
  type DictationListener,
} from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

type DictationUpdate = {
  kind?: string;
  text?: string;
};

function invokeMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Allow the microphone to dictate.";
}

/**
 * Speech.framework session for the macOS webview.
 *
 * Web Speech reports `service-not-allowed` here even after the permission
 * sheets succeed, so the composer listens to `dictation-update` instead.
 */
function createDesktopDictation(): DictationController {
  let generation = 0;
  let unlisten: UnlistenFn | null = null;
  let engine = false;

  const unsubscribe = () => {
    const current = unlisten;
    unlisten = null;
    current?.();
  };

  const stopEngine = () => {
    if (!engine) return;
    engine = false;
    void invoke("stop_dictation").catch(() => {
      /* The session was already released. */
    });
  };

  const stop = () => {
    generation += 1;
    unsubscribe();
    stopEngine();
  };

  return {
    start(next: DictationListener) {
      stop();
      const id = ++generation;
      const stale = () => generation !== id || next.signal.aborted;
      void (async () => {
        let invoked = false;
        try {
          if (stale()) return;
          const access = await invoke<{
            microphone?: string;
            speech?: string;
          }>("request_dictation_access");
          if (stale()) return;
          const denied = dictationAccessError(access);
          if (denied) {
            next.onError(denied);
            return;
          }
          const subscription = await listen<DictationUpdate>(
            "dictation-update",
            (event) => {
              if (stale()) return;
              const text = event.payload?.text ?? "";
              if (event.payload?.kind === "error") {
                next.onError(text || "Dictation stopped.");
                return;
              }
              if (event.payload?.kind === "final") {
                next.onFinal(text);
                return;
              }
              if (text) next.onPartial(text);
            },
          );
          if (stale()) {
            subscription();
            return;
          }
          unlisten = subscription;
          invoked = true;
          await invoke("start_dictation");
          if (stale()) {
            void invoke("stop_dictation").catch(() => {
              /* Replaced before the engine reported ready. */
            });
            unsubscribe();
            return;
          }
          engine = true;
        } catch (error) {
          unsubscribe();
          if (invoked) {
            void invoke("stop_dictation").catch(() => {
              /* Start failed after the engine was requested. */
            });
          }
          engine = false;
          if (stale()) return;
          next.onError(invokeMessage(error));
        }
      })();
    },
    stop,
  };
}

/** Ask macOS, then dictate with the system recognizer. */
function installDesktopDictation(): void {
  if (typeof window === "undefined" || !isTauriRuntime()) return;
  if (!navigator.platform.includes("Mac")) return;
  setSharedDictation(createDesktopDictation);
}

installDesktopDictation();
