import { colorContrast } from "../appearance.ts";
import type { ResolvedTheme } from "../types.ts";
import { fontFamilies, fontStack } from "./font-family.ts";
import {
  isThemePresetId,
  themePresets,
  type ThemePresetId,
} from "./presets.ts";

export type ThemeOverrides = Partial<{
  accent: string;
  ink: string;
  surface: string;
  contrast: number;
  diffAdded: string;
  diffRemoved: string;
  attention: string;
}>;

export type WindowMaterial = "translucent" | "opaque";
export type ThemePreferences = {
  themePreset?: ThemePresetId;
  themeOverrides?: ThemeOverrides;
  uiFont?: string;
  codeFont?: string;
  windowMaterial?: WindowMaterial;
};

export type ThemeSeed = {
  accent: string;
  ink: string;
  surface: string;
  contrast: number;
  fonts: { ui: string; code: string };
  opaqueWindows: boolean;
  semantic: { diffAdded: string; diffRemoved: string; attention: string };
};

const hex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const level = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 100;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeThemePreferences(value: unknown): ThemePreferences {
  const input = record(value) ?? {};
  const overrides = record(input.themeOverrides) ?? {};
  const themeOverrides: ThemeOverrides = {};
  for (const key of [
    "accent",
    "ink",
    "surface",
    "diffAdded",
    "diffRemoved",
    "attention",
  ] as const) {
    const color = overrides[key];
    if (hex(color)) themeOverrides[key] = color.toLowerCase();
  }
  if (level(overrides.contrast)) themeOverrides.contrast = overrides.contrast;
  return {
    themePreset: isThemePresetId(input.themePreset)
      ? input.themePreset
      : undefined,
    themeOverrides: Object.keys(themeOverrides).length
      ? themeOverrides
      : undefined,
    uiFont:
      typeof input.uiFont === "string" && fontFamilies(input.uiFont)
        ? input.uiFont
        : undefined,
    codeFont:
      typeof input.codeFont === "string" && fontFamilies(input.codeFont)
        ? input.codeFont
        : undefined,
    windowMaterial:
      input.windowMaterial === "opaque" ||
      input.windowMaterial === "translucent"
        ? input.windowMaterial
        : undefined,
  };
}

export function themeSeed(
  variant: ResolvedTheme,
  preferences: ThemePreferences & {
    mainColor?: string;
    secondaryColor?: string;
  },
): ThemeSeed {
  const settings = normalizeThemePreferences(preferences);
  const id = settings.themePreset ?? "gyro";
  const preset = themePresets[id][variant];
  const overrides = settings.themeOverrides ?? {};
  const legacyColor = (value?: string) =>
    !settings.themePreset && hex(value) && value.toLowerCase() !== "#ffffff"
      ? value
      : undefined;
  return {
    accent:
      overrides.accent ?? legacyColor(preferences.mainColor) ?? preset.accent,
    ink: overrides.ink ?? preset.ink,
    surface: overrides.surface ?? preset.surface,
    contrast:
      overrides.contrast ??
      (id === "gyro-high-contrast" ? 95 : variant === "dark" ? 60 : 45),
    fonts: { ui: settings.uiFont ?? "", code: settings.codeFont ?? "" },
    opaqueWindows: settings.windowMaterial === "opaque",
    semantic: {
      diffAdded: overrides.diffAdded ?? preset.semantic.diffAdded,
      diffRemoved: overrides.diffRemoved ?? preset.semantic.diffRemoved,
      attention:
        overrides.attention ??
        legacyColor(preferences.secondaryColor) ??
        preset.semantic.attention,
    },
  };
}

function mix(from: string, to: string, amount: number) {
  return (
    "#" +
    [1, 3, 5]
      .map((offset) => {
        const a = parseInt(from.slice(offset, offset + 2), 16);
        const b = parseInt(to.slice(offset, offset + 2), 16);
        return Math.round(a + (b - a) * amount)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

function readable(color: string, background: string, minimum = 4.5) {
  const extremes = ["#ffffff", "#000000"] as const;
  const target =
    colorContrast(extremes[0], background) >
    colorContrast(extremes[1], background)
      ? extremes[0]
      : extremes[1];
  for (let step = 0; step < 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (colorContrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

export function deriveThemeTokens(
  seed: ThemeSeed,
  variant: ResolvedTheme,
): Record<string, string> {
  const dark = variant === "dark";
  const contrast = Math.pow(seed.contrast / 100, 1.3);
  const app = seed.surface;
  const ink = readable(seed.ink, app, 7);
  const panel = mix(app, ink, dark ? 0.055 : 0.022);
  const raised = mix(app, ink, dark ? 0.077 : 0.034);
  const accent = readable(seed.accent, raised);
  const primaryText = readable(ink, raised, 7);
  const secondaryText = readable(
    mix(raised, ink, 0.58 + contrast * 0.2),
    raised,
  );
  const tertiaryText = mix(raised, ink, 0.43 + contrast * 0.18);
  const border = (amount: number) => colorWithAlpha(ink, amount);
  const primaryBg = mix(seed.accent, accent, 0.22);
  const primaryFg = readable("#ffffff", primaryBg);
  const codeBg = mix(app, dark ? "#000000" : ink, 0.055);
  return {
    "--gyro-app": app,
    "--gyro-pane": app,
    "--gyro-scope-content": app,
    "--gyro-sidebar": mix(app, ink, dark ? 0.05 : 0.03),
    "--gyro-surface": panel,
    "--gyro-surface-raised": raised,
    "--gyro-surface-soft": mix(app, ink, dark ? 0.065 : 0.045),
    "--gyro-control-hover": mix(raised, ink, 0.055 + contrast * 0.08),
    "--gyro-control-active": mix(raised, ink, 0.09 + contrast * 0.12),
    "--gyro-user-bubble": mix(panel, seed.accent, dark ? 0.1 : 0.08),
    "--gyro-diff-added": readable(seed.semantic.diffAdded, panel),
    "--gyro-diff-removed": readable(seed.semantic.diffRemoved, panel),
    "--gyro-border-soft": border(0.062 + contrast * 0.06),
    "--gyro-border": border(0.105 + contrast * 0.11),
    "--gyro-border-strong": border(0.19 + contrast * 0.2),
    "--gyro-border-heavy": border(0.19 + contrast * 0.2),
    "--gyro-focus-ring": accent,
    "--gyro-control-edge": mix(raised, ink, 0.35 + contrast * 0.15),
    "--gyro-text": primaryText,
    "--gyro-muted": secondaryText,
    "--gyro-faint": tertiaryText,
    "--gyro-sidebar-text": primaryText,
    "--gyro-hover-text": primaryText,
    "--gyro-accent": accent,
    "--gyro-accent-strong": readable(seed.accent, raised, 5.5),
    "--gyro-secondary-accent": readable(seed.semantic.attention, raised),
    "--gyro-secondary-accent-strong": readable(
      seed.semantic.attention,
      raised,
      5.5,
    ),
    "--gyro-primary-bg": primaryBg,
    "--gyro-primary-hover": mix(primaryBg, primaryFg, 0.08),
    "--gyro-primary-text": primaryFg,
    "--gyro-user-main": seed.accent,
    "--gyro-user-secondary": seed.semantic.attention,
    "--gyro-attention": seed.semantic.attention,
    "--gyro-attention-soft": colorWithAlpha(seed.semantic.attention, 0.14),
    "--gyro-success": readable(seed.semantic.diffAdded, panel, 3),
    "--gyro-danger": readable(seed.semantic.diffRemoved, panel, 3),
    "--gyro-code-bg": codeBg,
    "--gyro-code-text": primaryText,
    "--gyro-code-keyword": readable(seed.accent, codeBg),
    "--gyro-code-string": readable(seed.semantic.diffAdded, codeBg),
    "--gyro-code-number": readable(seed.semantic.attention, codeBg),
    "--gyro-code-symbol": readable(
      mix(seed.accent, seed.semantic.diffRemoved, 0.5),
      codeBg,
    ),
    "--gyro-segment-active": mix(raised, ink, 0.07 + contrast * 0.07),
  };
}

function colorWithAlpha(color: string, amount: number) {
  return `${color}${Math.round(amount * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

const prefix = "gyro-theme-v1:";

export function exportTheme(variant: ResolvedTheme, seed: ThemeSeed) {
  const value = prefix + JSON.stringify({ variant, seed });
  if (!importTheme(value)) throw new Error("Invalid Gyro theme.");
  return value;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function importTheme(
  value: string,
): { variant: ResolvedTheme; preferences: ThemePreferences } | undefined {
  if (value.length > 4_096 || !value.startsWith(prefix)) return undefined;
  try {
    const data = record(JSON.parse(value.slice(prefix.length)));
    const seed = record(data?.seed);
    const fonts = record(seed?.fonts);
    const semantic = record(seed?.semantic);
    if (
      !data ||
      (data.variant !== "dark" && data.variant !== "light") ||
      !seed ||
      !hex(seed.accent) ||
      !hex(seed.ink) ||
      !hex(seed.surface) ||
      !level(seed.contrast) ||
      typeof seed.opaqueWindows !== "boolean" ||
      !fonts ||
      typeof fonts.ui !== "string" ||
      !fontFamilies(fonts.ui) ||
      typeof fonts.code !== "string" ||
      !fontFamilies(fonts.code) ||
      !semantic ||
      !hex(semantic.diffAdded) ||
      !hex(semantic.diffRemoved) ||
      !hex(semantic.attention) ||
      !hasOnlyKeys(data, ["variant", "seed"]) ||
      !hasOnlyKeys(seed, [
        "accent",
        "ink",
        "surface",
        "contrast",
        "fonts",
        "opaqueWindows",
        "semantic",
      ]) ||
      !hasOnlyKeys(fonts, ["ui", "code"]) ||
      !hasOnlyKeys(semantic, ["diffAdded", "diffRemoved", "attention"])
    )
      return undefined;
    return {
      variant: data.variant,
      preferences: normalizeThemePreferences({
        themePreset: "gyro",
        themeOverrides: { ...seed, ...semantic },
        uiFont: fonts.ui,
        codeFont: fonts.code,
        windowMaterial: seed.opaqueWindows ? "opaque" : "translucent",
      }),
    };
  } catch {
    return undefined;
  }
}

export { fontStack };
