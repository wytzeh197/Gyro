import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setSharedDictation } from "@gyro-dev/ui";
import { createDesktopDictation } from "./desktop-dictation";
import { isTauriRuntime } from "./tauri-runtime";

/** Use Speech.framework: Web Speech is unavailable in the macOS webview. */
function installDesktopDictation(): void {
  if (typeof window === "undefined" || !isTauriRuntime()) return;
  if (!navigator.platform.includes("Mac")) return;
  setSharedDictation(() =>
    createDesktopDictation({
      invoke,
      listen: (callback) =>
        listen("dictation-update", (event) =>
          callback(event.payload as { kind?: string; text?: string }),
        ),
    }),
  );
}

installDesktopDictation();
