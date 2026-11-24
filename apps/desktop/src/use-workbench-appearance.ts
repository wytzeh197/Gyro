import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { syncNativeAppearance, syncNativeMaterial } from "./native-appearance";
import { fontStack } from "@gyro-dev/ui/theme";
import {
  applyAppearancePreferences,
  interfaceScales,
  type ResolvedTheme,
  type ThemeMode,
  type WorkbenchPreferences,
} from "@gyro-dev/ui";

export const THEME_STORAGE_KEY = "gyro.theme";

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function storedThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "dark" || value === "light"
    ? value
    : undefined;
}
export function useWorkbenchAppearance(preferences: WorkbenchPreferences) {
  const themePreference = preferences.theme;
  useEffect(() => {
    syncNativeAppearance(themePreference);
  }, [themePreference]);
  const [systemThemeValue, setSystemThemeValue] =
    useState<ResolvedTheme>(systemTheme);
  const resolvedTheme: ResolvedTheme =
    themePreference === "system" ? systemThemeValue : themePreference;
  const [reduceMotion, setReduceMotion] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const appearance = useMemo(
    () => ({
      scale: interfaceScales[preferences.interfaceSize],
      reduceMotion,
      codeFont: preferences.codeFont ? fontStack(preferences.codeFont, "code") : undefined,
    }),
    [preferences.interfaceSize, preferences.codeFont, reduceMotion],
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemThemeValue(media.matches ? "dark" : "light");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [themePreference]);

  useLayoutEffect(() => {
    document.documentElement.dataset.reduceMotion = String(reduceMotion);
  }, [reduceMotion]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    syncNativeMaterial(preferences.windowMaterial);
    const themeColor = applyAppearancePreferences(
      document.documentElement,
      preferences,
      resolvedTheme,
    );
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        themeColor ?? (resolvedTheme === "light" ? "#f9f8f7" : "#1e1e1d"),
      );
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      /* Preview storage can be unavailable. */
    }
  }, [
    resolvedTheme,
    themePreference,
    preferences,
  ]);

  return { resolvedTheme, reduceMotion, appearance };
}
