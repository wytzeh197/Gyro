import type { WorkbenchPreferences } from "./types";

export const TRANSFER_KEYS = [
  "theme",
  "mainColor",
  "secondaryColor",
  "density",
  "interfaceSize",
  "motionSpeed",
  "launchView",
  "showMenuBarIcon",
  "modelFollow",
  "desktopNotifications",
  "checkReminders",
  "workspaceKeybindings",
] as const;
export type PortableSettings = Pick<
  WorkbenchPreferences,
  (typeof TRANSFER_KEYS)[number]
>;
const choices: Record<string, readonly string[]> = {
  theme: ["system", "light", "dark"],
  density: ["compact", "comfortable"],
  interfaceSize: ["small", "default", "large"],
  motionSpeed: ["slower", "default", "faster"],
  launchView: ["last", "workspace", "sessions", "terminals"],
  modelFollow: ["off", "peek", "follow"],
};
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fail(): never {
  throw new Error(
    "This settings file is invalid or contains unsupported fields. Nothing was changed.",
  );
}
export function parseSettingsTransfer(text: string): Partial<PortableSettings> {
  if (text.length > 65_536)
    throw new Error("Settings files must be smaller than 64 KB.");
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return fail();
  }
  if (
    !object(file) ||
    Object.keys(file).some(
      (k) => !["format", "version", "settings"].includes(k),
    ) ||
    file.format !== "gyro-settings" ||
    file.version !== 1 ||
    !object(file.settings)
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(file.settings)) {
    if (!(TRANSFER_KEYS as readonly string[]).includes(key)) return fail();
    if (key in choices) {
      if (typeof value !== "string" || !choices[key]!.includes(value))
        return fail();
    } else if (key === "mainColor" || key === "secondaryColor") {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
        return fail();
    } else if (key === "showMenuBarIcon" || key === "checkReminders") {
      if (typeof value !== "boolean") return fail();
    } else if (key === "desktopNotifications") {
      if (
        !object(value) ||
        Object.entries(value).some(
          ([k, v]) =>
            ![
              "enabled",
              "approvals",
              "finished",
              "failed",
              "showNames",
            ].includes(k) || typeof v !== "boolean",
        )
      )
        return fail();
      if (
        ["enabled", "approvals", "finished", "failed"].some(
          (k) => typeof value[k] !== "boolean",
        )
      )
        return fail();
    } else if (key === "workspaceKeybindings") {
      if (!object(value) || Object.keys(value).length > 200) return fail();
      for (const [id, binding] of Object.entries(value)) {
        if (
          !/^[a-zA-Z0-9._-]{1,128}$/.test(id) ||
          ["__proto__", "constructor", "prototype"].includes(id)
        )
          return fail();
        if (binding === null) continue;
        if (
          !object(binding) ||
          typeof binding.key !== "string" ||
          binding.key.length < 1 ||
          binding.key.length > 32 ||
          Object.entries(binding).some(
            ([k, v]) =>
              k !== "key" &&
              (!["primary", "control", "shift", "alt"].includes(k) ||
                typeof v !== "boolean"),
          )
        )
          return fail();
      }
    }
    result[key] = value;
  }
  if (!Object.keys(result).length) return fail();
  return result as Partial<PortableSettings>;
}
export function exportSettingsTransfer(
  preferences: WorkbenchPreferences,
): string {
  const settings = Object.fromEntries(
    TRANSFER_KEYS.filter((k) => preferences[k] !== undefined).map((k) => [
      k,
      preferences[k],
    ]),
  );
  const text = JSON.stringify(
    { format: "gyro-settings", version: 1, settings },
    null,
    2,
  );
  parseSettingsTransfer(text);
  return text;
}
