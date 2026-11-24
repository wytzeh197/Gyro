import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AppPreviewRuntime,
  AppPreviewObservation,
  AppPreviewTarget,
  PreviewScheme,
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
  const loadImage = (value: AppPreviewObservation) => ({
    ...value,
    screenshot: {
      ...value.screenshot,
      src: convertFileSrc(value.screenshot.path),
    },
  });
  const client: AppPreviewRuntime = {
    key,
    targets: () => request("targets"),
    select: (targetId) => request<AppPreviewTarget>("select", { targetId }),
    capture: async () =>
      loadImage(await request<AppPreviewObservation>("capture")),
    schemes: () => request<PreviewScheme[]>("schemes"),
    run: async (scheme) =>
      loadImage(
        await request<AppPreviewObservation>("run", {
          options: { project: scheme.project, scheme: scheme.name },
        }),
      ),
    openDevice: () => request("open-device"),
    xcodeSetup: /Mac/.test(navigator.platform)
      ? {
          check: () => request("xcode-setup"),
          choose: async () => {
            const path = await open({
              title: "Choose Xcode",
              defaultPath: "/Applications",
              multiple: false,
              filters: [{ name: "Xcode application", extensions: ["app"] }],
            });
            if (typeof path === "string") {
              await request("choose-xcode", { options: { xcodePath: path } });
            }
          },
          open: () => request("open-xcode"),
          download: (source) => {
            if (source.kind === "app-store") {
              return openUrl("https://apps.apple.com/app/xcode/id497799835");
            }
            if (source.kind === "version") {
              const query = encodeURIComponent(`Xcode ${source.version}`);
              return openUrl(
                `https://developer.apple.com/download/all/?q=${query}`,
              );
            }
            return openUrl(
              "https://developer.apple.com/xcode/system-requirements/",
            );
          },
        }
      : undefined,
    simulatorFrame: () => request("simulator-frame"),
    crop: (captureId, region) =>
      request("crop", { captureId, options: { region } }),
    subscribeBuild: (callback) => {
      let disposed = false;
      const subscription = listen<{
        sessionId: string;
        workspace: string;
        targetId: string;
        phase: string;
      }>("gyro:app-preview-build", ({ payload }) => {
        if (
          !disposed &&
          payload.sessionId === sessionId &&
          payload.workspace === workspaceKey
        )
          callback(payload);
      });
      return () => {
        disposed = true;
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      };
    },
    click: (captureId, x, y) => request("click", { captureId, x, y }),
    subscribe: (callback) => {
      let disposed = false;
      const subscription = listen<{ sessionId: string; workspace: string }>(
        "gyro:app-preview-changed",
        (event) => {
          if (
            !disposed &&
            event.payload.sessionId === sessionId &&
            event.payload.workspace === workspaceKey
          )
            callback();
        },
      );
      const captures = listen<
        AppPreviewObservation & {
          owner: { sessionId: string; workspace: string };
        }
      >("gyro:app-preview-captured", (event) => {
        if (
          !disposed &&
          event.payload.owner.sessionId === sessionId &&
          event.payload.owner.workspace === workspaceKey
        )
          callback(loadImage(event.payload));
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
