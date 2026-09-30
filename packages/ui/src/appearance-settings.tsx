import { useRef, type CSSProperties, type RefObject } from "react";
import { RotateCcw } from "lucide-react";
import { appearanceAccentProperties } from "./appearance";
import type {
  InterfaceSize,
  MotionSpeed,
  ThemeMode,
  WorkbenchDensity,
} from "./types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmented,
} from "./settings-controls";

/** Gyro's own palette. Reset only appears once either colour has moved off it. */
const DEFAULT_MAIN_COLOR = "#0874df";
const DEFAULT_SECONDARY_COLOR = "#8b6fcb";

type AppearanceSettingsProps = {
  themeMode: ThemeMode;
  density: WorkbenchDensity;
  interfaceSize: InterfaceSize;
  motionSpeed: MotionSpeed;
  reduceMotion: boolean;
  mainColor: string;
  secondaryColor: string;
  onThemeChange: (theme: ThemeMode) => void;
  onDensityChange?: (density: WorkbenchDensity) => void;
  onInterfaceSizeChange?: (size: InterfaceSize) => void;
  onMotionSpeedChange?: (speed: MotionSpeed) => void;
  onAppearanceColorsChange?: (main: string, secondary: string) => void;
};

export function AppearanceSettings({
  themeMode,
  density,
  interfaceSize,
  motionSpeed,
  reduceMotion,
  mainColor,
  secondaryColor,
  onThemeChange,
  onDensityChange,
  onInterfaceSizeChange,
  onMotionSpeedChange,
  onAppearanceColorsChange,
}: AppearanceSettingsProps) {
  // Reset unmounts itself once the palette is back to default, so focus moves
  // to the Main color control instead of falling back to the page.
  const mainColorInputRef = useRef<HTMLInputElement>(null);
  // Each preview's accent is the one that theme will really paint: the same
  // contrast-adjusted value the app applies, not a fixed mix of the pick.
  const previewAccent = (palette: "light" | "dark") =>
    appearanceAccentProperties(mainColor, secondaryColor, palette)[
      "--gyro-accent"
    ];
  return (
    <>
      <SettingsGroup label="Theme">
        <div
          className="gyro-theme-picker"
          data-setting-key="theme"
          role="group"
          aria-label="Theme"
          tabIndex={-1}
        >
          {(
            [
              { mode: "system", label: "System" },
              { mode: "light", label: "Light" },
              { mode: "dark", label: "Dark" },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              aria-pressed={themeMode === mode}
              className={`is-${mode}${themeMode === mode ? " is-active" : ""}`}
              onClick={() => onThemeChange(mode)}
              type="button"
            >
              <span aria-hidden="true" className="gyro-theme-preview">
                <ThemePreviewWindow
                  accent={previewAccent(mode === "dark" ? "dark" : "light")}
                  palette={mode === "dark" ? "dark" : "light"}
                />
                {mode === "system" ? (
                  <ThemePreviewWindow
                    accent={previewAccent("dark")}
                    palette="dark"
                  />
                ) : null}
              </span>
              <span className="gyro-theme-picker-label">{label}</span>
            </button>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup label="Interface">
        <SettingsRow
          label="Interface size"
          detail="Scale text and controls, including the editor and terminal."
        >
          <SettingsSegmented
            label="Interface size"
            value={interfaceSize}
            options={[
              { label: "Small", value: "small" },
              { label: "Default", value: "default" },
              { label: "Large", value: "large" },
            ]}
            onChange={(value) => onInterfaceSizeChange?.(value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Density"
          detail="Choose tighter rows or more room between controls."
        >
          <SettingsSegmented
            label="Interface density"
            value={density}
            options={[
              { label: "Compact", value: "compact" },
              { label: "Comfortable", value: "comfortable" },
            ]}
            onChange={(value) => onDensityChange?.(value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Animation speed"
          detail={
            reduceMotion
              ? "macOS Reduce Motion is on. Animations stay reduced; your speed is saved for when it is off."
              : "Adjust how quickly menus and panels appear. Follows macOS Reduce Motion."
          }
        >
          <SettingsSegmented
            label="Animation speed"
            value={motionSpeed}
            options={[
              { label: "Slower", value: "slower" },
              { label: "Default", value: "default" },
              { label: "Faster", value: "faster" },
            ]}
            onChange={(value) => onMotionSpeedChange?.(value)}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label="Colors">
        <SettingsRow
          label="Main color"
          detail="Selection, focus, and primary action color."
        >
          <AppearanceColorControl
            color={mainColor}
            inputRef={mainColorInputRef}
            label="Main color"
            onChange={(color) =>
              onAppearanceColorsChange?.(color, secondaryColor)
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Secondary color"
          detail="Supporting icons, badges, and quiet highlights."
        >
          <AppearanceColorControl
            color={secondaryColor}
            label="Secondary color"
            onChange={(color) => onAppearanceColorsChange?.(mainColor, color)}
          />
        </SettingsRow>
        {mainColor.toLowerCase() !== DEFAULT_MAIN_COLOR ||
        secondaryColor.toLowerCase() !== DEFAULT_SECONDARY_COLOR ? (
          <SettingsRow
            label="Default palette"
            detail="Restore Gyro blue and violet."
          >
            <button
              className="gyro-button is-secondary is-small gyro-color-reset"
              onClick={() => {
                onAppearanceColorsChange?.(
                  DEFAULT_MAIN_COLOR,
                  DEFAULT_SECONDARY_COLOR,
                );
                mainColorInputRef.current?.focus();
              }}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={13} />
              Reset colors
            </button>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </>
  );
}

/** A miniature Gyro window in one theme's real colours: the sidebar with its
    chats, a message and its reply, and the composer whose send button carries
    the main colour. The System card stacks both and shows the dark half on
    the right. */
function ThemePreviewWindow({
  accent,
  palette,
}: {
  accent: string;
  palette: "light" | "dark";
}) {
  return (
    <span
      className="gyro-theme-preview-window"
      data-palette={palette}
      style={{ "--preview-accent": accent } as CSSProperties}
    >
      <span className="gyro-theme-preview-sidebar">
        <i />
        <i className="is-active" />
        <i />
        <i />
      </span>
      <span className="gyro-theme-preview-main">
        <i className="is-bubble" />
        <i className="is-title" />
        <i />
        <i className="is-short" />
        <span className="gyro-theme-preview-composer">
          <i />
        </span>
      </span>
    </span>
  );
}

function AppearanceColorControl({
  color,
  inputRef,
  label,
  onChange,
}: {
  color: string;
  inputRef?: RefObject<HTMLInputElement>;
  label: string;
  onChange: (color: string) => void;
}) {
  return (
    <label
      className="gyro-color-control"
      style={{ "--gyro-color-preview": color } as CSSProperties}
    >
      <input
        aria-label={label}
        ref={inputRef}
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={color}
      />
      <span aria-hidden="true" className="gyro-color-swatch" />
      <code>{color.toUpperCase()}</code>
    </label>
  );
}
