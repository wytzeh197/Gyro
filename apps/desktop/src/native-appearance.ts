import { isTauri } from "@tauri-apps/api/core";
import { setTheme } from "@tauri-apps/api/app";
import type { ThemeMode } from "@gyro-dev/ui";

/** Keep AppKit's frosted material on the same appearance as the main UI. */
export function syncNativeAppearance(theme: ThemeMode): void {
  if (
    !isTauri() ||
    document.documentElement.dataset.nativeMaterial !== "sidebar"
  ) {
    return;
  }
  void setTheme(theme === "system" ? null : theme).catch((error) => {
    console.warn("Could not update Gyro's native appearance", error);
  });
}
