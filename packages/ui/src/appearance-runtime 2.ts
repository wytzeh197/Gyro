import {
  appearanceAccentProperties,
  normalizedInterfaceSize,
  normalizedMotionSpeed,
} from "./appearance";
import type { ResolvedTheme, WorkbenchPreferences } from "./types";

export function applyAppearancePreferences(
  root: HTMLElement,
  preferences: Pick<
    WorkbenchPreferences,
    "interfaceSize" | "motionSpeed" | "mainColor" | "secondaryColor"
  >,
  theme: ResolvedTheme,
) {
  root.dataset.interfaceSize = normalizedInterfaceSize(
    preferences.interfaceSize,
  );
  root.dataset.motionSpeed = normalizedMotionSpeed(preferences.motionSpeed);
  for (const [name, value] of Object.entries(
    appearanceAccentProperties(
      preferences.mainColor,
      preferences.secondaryColor,
      theme,
    ),
  )) {
    root.style.setProperty(name, value);
  }
}
