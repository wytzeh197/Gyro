import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NativePorts } from "./client";
export const nativePorts: NativePorts = {
  invoke, listen,
  async prepareMedia(file, kind) {
    const encodedName = btoa(Array.from(new TextEncoder().encode(file.name),
      (byte) => String.fromCharCode(byte)).join(""));
    return invoke("prepare_chat_media_upload", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-gyro-kind": kind, "x-gyro-name": encodedName, "x-gyro-session-id": "new" },
    });
  },
};
