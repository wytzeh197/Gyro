import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./tauri-runtime";

export function useQuitConfirmation() {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void listen("gyro-quit-requested", () => {
      if (mounted) setRequested(true);
    })
      .then(async (dispose) => {
        if (!mounted) {
          dispose();
          return;
        }
        unlisten = dispose;
        // Recover requests made while the main window was loading or reopening.
        const pending = await invoke<boolean>("get_quit_confirmation");
        if (mounted && pending) setRequested(true);
      })
      .catch((error) =>
        console.error("Could not listen for Gyro quit requests", error),
      );
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  return {
    requested,
    async resolve(quit: boolean) {
      await invoke("resolve_quit_confirmation", { quit });
      setRequested(false);
    },
  };
}
