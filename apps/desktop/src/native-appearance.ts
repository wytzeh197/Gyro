import { isTauri } from "@tauri-apps/api/core";
import { setTheme } from "@tauri-apps/api/app";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemeMode } from "@gyro-dev/ui";
import type { WindowMaterial } from "@gyro-dev/ui/theme";

function supportsNativeMaterial() {
  return (
    isTauri() &&
    navigator.platform.includes("Mac") &&
    document.documentElement.dataset.surface === "main"
  );
}

let requestedMaterial: WindowMaterial | undefined;
let materialUpdate = Promise.resolve();

export function syncNativeMaterial(material: WindowMaterial = "translucent") {
  const root = document.documentElement;
  if (!supportsNativeMaterial() || requestedMaterial === material) return;
  root.dataset.nativeMaterial =
    material === "translucent" ? "sidebar" : "opaque";
  requestedMaterial = material;
  materialUpdate = materialUpdate
    .then(async () => {
      if (requestedMaterial !== material) return;
      const window = getCurrentWindow();
      if (material === "opaque") await window.clearEffects();
      else
        await window.setEffects({
          effects: [Effect.Sidebar],
          state: EffectState.FollowsWindowActiveState,
        });
    })
    .catch((error) => {
      if (requestedMaterial === material) {
        requestedMaterial = undefined;
        root.dataset.nativeMaterial = "opaque";
      }
      console.warn("Could not update Gyro's native window material", error);
    });
}

/** Keep AppKit's frosted material on the same appearance as the main UI. */
export function syncNativeAppearance(theme: ThemeMode): void {
  if (!supportsNativeMaterial()) return;
  void setTheme(theme === "system" ? null : theme).catch((error) => {
    console.warn("Could not update Gyro's native appearance", error);
  });
}
