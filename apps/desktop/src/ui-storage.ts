import type { WorkbenchPreferences } from "@gyro-dev/ui";

export type AppearancePreferences = Pick<
  WorkbenchPreferences,
  | "theme"
  | "interfaceSize"
  | "density"
  | "motionSpeed"
  | "mainColor"
  | "secondaryColor"
>;

export const APPEARANCE_STORAGE_KEY = "gyro.appearance.v1";

/** Keep appearance independent of the much larger workspace snapshot. */
export function saveAppearancePreferences(preferences: AppearancePreferences) {
  const {
    theme,
    interfaceSize,
    density,
    motionSpeed,
    mainColor,
    secondaryColor,
  } = preferences;
  return safeSetLocalStorage(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      theme,
      interfaceSize,
      density,
      motionSpeed,
      mainColor,
      secondaryColor,
    }),
  );
}

export function readStoredAppearance(): Partial<AppearancePreferences> {
  const stored = readBoundedLocalStorage(APPEARANCE_STORAGE_KEY, 1_024);
  if (!stored) return {};
  try {
    const value = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const appearance: Partial<AppearancePreferences> = {};
    if (["system", "light", "dark"].includes(value.theme))
      appearance.theme = value.theme;
    if (["small", "default", "large"].includes(value.interfaceSize))
      appearance.interfaceSize = value.interfaceSize;
    if (["compact", "comfortable"].includes(value.density))
      appearance.density = value.density;
    if (["slower", "default", "faster"].includes(value.motionSpeed))
      appearance.motionSpeed = value.motionSpeed;
    for (const key of ["mainColor", "secondaryColor"] as const) {
      if (typeof value[key] === "string" && /^#[0-9a-f]{6}$/i.test(value[key]))
        appearance[key] = value[key];
    }
    return appearance;
  } catch {
    return {};
  }
}

/** Read only bounded UI state; unavailable or oversized storage restores defaults. */
export function readBoundedLocalStorage(key: string, maxChars: number) {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored || stored.length > maxChars) return undefined;
    return stored;
  } catch {
    return undefined;
  }
}

export function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Local storage can be unavailable or quota-limited in preview contexts.
    return false;
  }
}
