import type { InterfaceSize, MotionSpeed, ResolvedTheme } from "./types";

export const interfaceScales: Record<InterfaceSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.15,
};

export function normalizedInterfaceSize(value: unknown): InterfaceSize {
  return value === "small" || value === "large" ? value : "default";
}

export function normalizedMotionSpeed(value: unknown): MotionSpeed {
  return value === "slower" || value === "faster" ? value : "default";
}

function rgb(hex: string) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

export function colorContrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const channels = rgb(hex).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (
      channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    );
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Change HSL lightness without washing the chosen hue into white or gray. */
function tone(color: string, amount: number, lighter: boolean) {
  const channels = rgb(color).map((channel) => channel / 255);
  const lightness = (Math.max(...channels) + Math.min(...channels)) / 2;
  const next = lightness + ((lighter ? 1 : 0) - lightness) * amount;
  const span = 1 - Math.abs(2 * lightness - 1);
  const scale = span === 0 ? 0 : (1 - Math.abs(2 * next - 1)) / span;
  return `#${channels
    .map((channel) =>
      Math.round(
        Math.max(0, Math.min(1, next + (channel - lightness) * scale)) * 255,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Preserve the chosen hue while keeping accent text and filled buttons readable.
 * The saved picker value is never rewritten; only its painted variants change. */
export function appearanceAccentProperties(
  main: string,
  secondary: string,
  theme: ResolvedTheme,
) {
  const dark = theme === "dark";
  const normalize = (value: string, fallback: string) =>
    /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  main = normalize(main, "#0874df");
  secondary = normalize(secondary, "#8b6fcb");
  const backgrounds = dark ? ["#181818", "#383c41"] : ["#ffffff", "#e7ebf0"];
  const target = dark ? "#ffffff" : "#101724";
  const readable = (color: string, initial: number, against = backgrounds) => {
    for (let step = 0; step <= 100; step++) {
      const candidate = tone(color, Math.min(1, initial + step / 100), dark);
      if (
        against.every(
          (background) => colorContrast(candidate, background) >= 4.5,
        )
      )
        return candidate;
    }
    return target;
  };
  const foreground = dark ? "#101724" : "#ffffff";
  return {
    "--gyro-accent": readable(main, 0.12),
    "--gyro-accent-strong": readable(main, dark ? 0.42 : 0.24),
    "--gyro-secondary-accent": readable(secondary, 0.12),
    "--gyro-secondary-accent-strong": readable(secondary, dark ? 0.34 : 0.24),
    "--gyro-primary-bg": readable(main, dark ? 0.32 : 0.12, [foreground]),
    "--gyro-primary-hover": readable(main, dark ? 0.42 : 0.24, [foreground]),
    "--gyro-primary-text": foreground,
  };
}
