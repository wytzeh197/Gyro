import { invoke } from "@tauri-apps/api/core";
import { createSessionBrowserQueue } from "./session-browser-queue";

// Shared by browser commands and both native event listeners in this webview.
export const sessionBrowserNative = createSessionBrowserQueue(invoke);
