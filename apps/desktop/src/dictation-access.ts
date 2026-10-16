import { invoke } from "@tauri-apps/api/core";
import { dictationAccessError, setDictationAccessRequest } from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

/** Ask macOS before the composer opens the speech recognizer. */
function installDictationAccessRequest(): void {
  if (typeof window === "undefined" || !isTauriRuntime()) return;
  if (!navigator.platform.includes("Mac")) return;
  setDictationAccessRequest(async () => {
    try {
      const access = await invoke<{
        microphone?: string;
        speech?: string;
      }>("request_dictation_access");
      return dictationAccessError(access);
    } catch {
      return "Allow the microphone to dictate.";
    }
  });
}

installDictationAccessRequest();
