import type { ResolvedTheme } from "../types";

type Palette = {
  accent: string;
  ink: string;
  surface: string;
  semantic: { diffAdded: string; diffRemoved: string; attention: string };
};

const palette = (
  surface: string,
  ink: string,
  accent: string,
  diffAdded: string,
  diffRemoved: string,
  attention: string,
): Palette => ({
  surface,
  ink,
  accent,
  semantic: { diffAdded, diffRemoved, attention },
});

export const themePresets = {
  gyro: {
    label: "Gyro",
    dark: palette(
      "#1e1e1d",
      "#f6f6f7",
      "#8fa8ff",
      "#5ed8a4",
      "#ff8995",
      "#ff7150",
    ),
    light: palette(
      "#f9f8f7",
      "#202020",
      "#315bca",
      "#20764d",
      "#a6314b",
      "#bd422c",
    ),
  },
  "gyro-high-contrast": {
    label: "Gyro High Contrast",
    dark: palette(
      "#101010",
      "#ffffff",
      "#adc0ff",
      "#86e9b3",
      "#ffadb6",
      "#ff997b",
    ),
    light: palette(
      "#ffffff",
      "#0a0a0a",
      "#2148bb",
      "#005e36",
      "#901831",
      "#9c260d",
    ),
  },
  catppuccin: {
    label: "Catppuccin",
    dark: palette(
      "#1e1e2e",
      "#cdd6f4",
      "#cba6f7",
      "#a6e3a1",
      "#f38ba8",
      "#fab387",
    ),
    light: palette(
      "#eff1f5",
      "#4c4f69",
      "#8839ef",
      "#33761c",
      "#ba1740",
      "#a74e0e",
    ),
  },
  dracula: {
    label: "Dracula",
    dark: palette(
      "#282a36",
      "#f8f8f2",
      "#bd93f9",
      "#50fa7b",
      "#ff5555",
      "#ffb86c",
    ),
    light: palette(
      "#f8f7fb",
      "#282a36",
      "#682ca3",
      "#147847",
      "#b52e4b",
      "#a35309",
    ),
  },
  nord: {
    label: "Nord",
    dark: palette(
      "#2e3440",
      "#eceff4",
      "#88c0d0",
      "#a3be8c",
      "#bf616a",
      "#ebcb8b",
    ),
    light: palette(
      "#eceff4",
      "#2e3440",
      "#375d91",
      "#487047",
      "#9b424f",
      "#866015",
    ),
  },
  solarized: {
    label: "Solarized",
    dark: palette(
      "#002b36",
      "#93a1a1",
      "#2aa198",
      "#859900",
      "#dc322f",
      "#cb4b16",
    ),
    light: palette(
      "#fdf6e3",
      "#405960",
      "#166e73",
      "#546b00",
      "#ac2825",
      "#964017",
    ),
  },
  "tokyo-night": {
    label: "Tokyo Night",
    dark: palette(
      "#1a1b26",
      "#c0caf5",
      "#7aa2f7",
      "#9ece6a",
      "#f7768e",
      "#e0af68",
    ),
    light: palette(
      "#e8e9ec",
      "#343b59",
      "#34548a",
      "#3a6742",
      "#8c3057",
      "#765824",
    ),
  },
  gruvbox: {
    label: "Gruvbox",
    dark: palette(
      "#282828",
      "#ebdbb2",
      "#fabd2f",
      "#b8bb26",
      "#fb4934",
      "#fe8019",
    ),
    light: palette(
      "#fbf1c7",
      "#3c3836",
      "#894e0a",
      "#626d06",
      "#9d0006",
      "#a14413",
    ),
  },
  "rose-pine": {
    label: "Rosé Pine",
    dark: palette(
      "#191724",
      "#e0def4",
      "#c4a7e7",
      "#9ccfd8",
      "#eb6f92",
      "#f6c177",
    ),
    light: palette(
      "#faf4ed",
      "#575279",
      "#785190",
      "#286983",
      "#a52b5b",
      "#96540d",
    ),
  },
  everforest: {
    label: "Everforest",
    dark: palette(
      "#2d353b",
      "#d3c6aa",
      "#a7c080",
      "#a7c080",
      "#e67e80",
      "#e69875",
    ),
    light: palette(
      "#fdf6e3",
      "#404a49",
      "#536f37",
      "#496a2c",
      "#9b3539",
      "#965122",
    ),
  },
  one: {
    label: "One",
    dark: palette(
      "#282c34",
      "#d7dae0",
      "#61afef",
      "#98c379",
      "#e06c75",
      "#e5c07b",
    ),
    light: palette(
      "#fafafa",
      "#383a42",
      "#305fa6",
      "#407530",
      "#a62d30",
      "#8b5800",
    ),
  },
  github: {
    label: "GitHub",
    dark: palette(
      "#0d1117",
      "#e6edf3",
      "#58a6ff",
      "#56d364",
      "#f85149",
      "#d29922",
    ),
    light: palette(
      "#ffffff",
      "#24292f",
      "#0969da",
      "#1a7f37",
      "#b42327",
      "#875600",
    ),
  },
} satisfies Record<string, { label: string } & Record<ResolvedTheme, Palette>>;

export type ThemePresetId = keyof typeof themePresets;
export const themePresetIds = Object.keys(themePresets) as ThemePresetId[];

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === "string" && Object.hasOwn(themePresets, value);
}
