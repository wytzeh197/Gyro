import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppPreviewRuntime,
  AppPreviewObservation,
  AppPreviewTarget,
} from "../../../packages/ui/src/app-preview-panel";
const clients = new Map<string, AppPreviewRuntime>();
export function appPreviewClient(
  sessionId: string,
  workspaceKey: string,
): AppPreviewRuntime {
  const key = JSON.stringify([sessionId, workspaceKey]);
  const existing = clients.get(key);
  if (existing) return existing;
  const request = <T>(action: string, args: Record<string, unknown> = {}) =>
    invoke<T>("app_preview_request", {
      sessionId,
      workspaceKey,
      action,
      ...args,
    });
  const client: AppPreviewRuntime = {
    key,
    targets: () => request("targets"),
    select: (targetId) => request<AppPreviewTarget>("select", { targetId }),
    capture: async () => {
      const value = await request<AppPreviewObservation>("capture");
      value.screenshot.src = convertFileSrc(value.screenshot.path);
      return value;
    },
    click: (captureId, x, y) => request("click", { captureId, x, y }),
    subscribe: (callback) => {
      let disposed = false;
      const subscription = listen<{ sessionId: string }>(
        "gyro:app-preview-changed",
        (event) => {
          if (!disposed && event.payload.sessionId === sessionId) callback();
        },
      );
      const captures = listen<
        AppPreviewObservation & { owner: { sessionId: string } }
      >("gyro:app-preview-captured", (event) => {
        if (!disposed && event.payload.owner.sessionId === sessionId) {
          event.payload.screenshot.src = convertFileSrc(
            event.payload.screenshot.path,
          );
          callback(event.payload);
        }
      });
      return () => {
        disposed = true;
        void subscription.then((unlisten) => unlisten()).catch(() => {});
        void captures.then((unlisten) => unlisten()).catch(() => {});
      };
    },
  };
  clients.set(key, client);
  return client;
}
