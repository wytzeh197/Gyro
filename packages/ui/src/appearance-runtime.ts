import {
  appearanceAccentProperties,
  normalizedInterfaceSize,
  normalizedMotionSpeed,
} from "./appearance.ts";
import {
  deriveThemeTokens,
  fontStack,
  themeSeed,
  type ThemePreferences,
} from "./theme/theme-engine.ts";
import type { ResolvedTheme, WorkbenchPreferences } from "./types.ts";

type Appearance = Partial<
  Pick<
    WorkbenchPreferences,
    "interfaceSize" | "motionSpeed" | "mainColor" | "secondaryColor" | "density"
  >
> &
  ThemePreferences;
const applied = new WeakMap<HTMLElement, Record<string, string>>();
const transitionFrames = new WeakMap<HTMLElement, number>();

export function applyAppearancePreferences(
  root: HTMLElement,
  preferences: Appearance,
  theme: ResolvedTheme,
) {
  root.dataset.interfaceSize = normalizedInterfaceSize(
    preferences.interfaceSize,
  );
  root.dataset.motionSpeed = normalizedMotionSpeed(preferences.motionSpeed);
  if (preferences.density) root.dataset.density = preferences.density;
  root.dataset.themePreset = preferences.themePreset ?? "gyro";
  root.dataset.windowMaterial = preferences.windowMaterial ?? "translucent";
  const mainColor = preferences.mainColor ?? "#ffffff";
  const secondaryColor = preferences.secondaryColor ?? "#ffffff";
  const colors: Record<string, string> =
    preferences.themePreset || preferences.themeOverrides
      ? deriveThemeTokens(themeSeed(theme, preferences), theme)
      : {
          ...appearanceAccentProperties(mainColor, secondaryColor, theme),
          "--gyro-user-main": mainColor,
          "--gyro-user-secondary": secondaryColor,
        };
  const properties = {
    ...colors,
    ...(preferences.uiFont && {
      "--gyro-font-sans": fontStack(preferences.uiFont, "ui"),
    }),
    ...(preferences.codeFont && {
      "--gyro-font-mono": fontStack(preferences.codeFont, "code"),
    }),
  };
  const previous = applied.get(root) ?? {};
  const keys = Object.keys(properties);
  if (
    keys.length === Object.keys(previous).length &&
    Object.entries(properties).every(
      ([name, value]) => previous[name] === value,
    )
  ) {
    return colors["--gyro-app"];
  }
  const view = root.ownerDocument.defaultView;
  if (view) root.classList.add("no-transitions");
  for (const name of Object.keys(previous)) {
    if (!Object.hasOwn(properties, name)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(properties)) {
    root.style.setProperty(name, value);
  }
  applied.set(root, properties);
  if (view) {
    void root.offsetWidth;
    const frame = transitionFrames.get(root);
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    transitionFrames.set(
      root,
      view.requestAnimationFrame(() => {
        root.classList.remove("no-transitions");
        transitionFrames.delete(root);
      }),
    );
  }
  return colors["--gyro-app"];
}
