import type { CSSProperties } from "react";
import { Check, RotateCcw } from "lucide-react";
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
  saveStatus?: "saving" | "saved" | "error";
  onRetrySave?: () => void;
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
  saveStatus,
  onRetrySave,
}: AppearanceSettingsProps) {
  return (
    <div className="gyro-appearance-settings">
      <div className="gyro-appearance-scope">
        <span>Applies across Gyro</span>
        <span
          aria-live="polite"
          aria-atomic="true"
          className={`gyro-appearance-save-status${saveStatus === "error" ? " is-error" : ""}`}
          role="status"
        >
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
              ? "Saved"
              : saveStatus === "error"
                ? "Couldn’t save changes."
                : "Changes apply immediately"}
          {saveStatus === "error" && onRetrySave ? (
            <button onClick={onRetrySave} type="button">
              Retry save
            </button>
          ) : null}
        </span>
      </div>
      <SettingsGroup
        label="Theme"
        description="Follow your Mac’s appearance or choose your own."
        actions={
          <AppearanceReset
            label="Reset theme"
            detail="Follow your Mac’s appearance."
            disabled={themeMode === "system"}
            onClick={() => onThemeChange("system")}
          />
        }
      >
        <div
          className="gyro-theme-picker"
          data-setting-key="theme"
          role="group"
          aria-label="Theme"
          tabIndex={-1}
        >
          {(
            [
              {
                mode: "system",
                label: "System",
                detail: "Match your Mac",
              },
              { mode: "light", label: "Light", detail: "Always light" },
              { mode: "dark", label: "Dark", detail: "Always dark" },
            ] as const
          ).map(({ mode, label, detail }) => (
            <button
              key={mode}
              aria-pressed={themeMode === mode}
              aria-label={`${label} theme`}
              className={`is-${mode}${themeMode === mode ? " is-active" : ""}`}
              onClick={() => onThemeChange(mode)}
              type="button"
            >
              <ThemePreview mode={mode} />
              <span className="gyro-theme-option-label">
                {label}
                <Check aria-hidden="true" size={13} />
              </span>
              <small>{detail}</small>
            </button>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup
        label="Text & layout"
        actions={
          <AppearanceReset
            label="Reset text & layout"
            detail="Restore default interface size and comfortable spacing."
            disabled={
              !onInterfaceSizeChange ||
              !onDensityChange ||
              (interfaceSize === "default" && density === "comfortable")
            }
            onClick={() => {
              onInterfaceSizeChange?.("default");
              onDensityChange?.("comfortable");
            }}
          />
        }
      >
        <SettingsRow
          label="Interface size"
          detail="Scale text and controls, including the editor and terminal."
        >
          <SettingsSegmented
            label="Interface size"
            disabled={!onInterfaceSizeChange}
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
          label="Spacing"
          detail="Choose tighter rows or more room between controls."
        >
          <SettingsSegmented
            label="Interface spacing"
            disabled={!onDensityChange}
            value={density}
            options={[
              { label: "Compact", value: "compact" },
              { label: "Comfortable", value: "comfortable" },
            ]}
            onChange={(value) => onDensityChange?.(value)}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        label="Motion"
        actions={
          <AppearanceReset
            label="Reset motion"
            detail="Restore the default animation speed."
            disabled={!onMotionSpeedChange || motionSpeed === "default"}
            onClick={() => onMotionSpeedChange?.("default")}
          />
        }
      >
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
            disabled={!onMotionSpeedChange}
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
      <SettingsGroup
        label="Colors"
        description="Choose colors for selection, actions, and supporting highlights."
        actions={
          <AppearanceReset
            label="Reset colors"
            detail="Restore Gyro blue and violet. Theme, size, spacing, and motion stay as you chose them."
            disabled={
              !onAppearanceColorsChange ||
              (mainColor.toLowerCase() === "#0874df" &&
                secondaryColor.toLowerCase() === "#8b6fcb")
            }
            onClick={() => onAppearanceColorsChange?.("#0874df", "#8b6fcb")}
          />
        }
      >
        <SettingsRow
          label="Primary accent"
          detail="Selection, focus, and primary action color."
        >
          <AppearanceColorControl
            color={mainColor}
            label="Primary accent"
            onChange={(color) =>
              onAppearanceColorsChange?.(color, secondaryColor)
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Secondary accent"
          detail="Supporting icons, badges, and quiet highlights."
        >
          <AppearanceColorControl
            color={secondaryColor}
            label="Secondary accent"
            onChange={(color) => onAppearanceColorsChange?.(mainColor, color)}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

function AppearanceReset({
  label,
  detail,
  disabled,
  onClick,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="gyro-settings-group-reset"
      disabled={disabled}
      onClick={onClick}
      title={detail}
      type="button"
    >
      <RotateCcw aria-hidden="true" size={12} />
      {label}
    </button>
  );
}

function ThemePreview({ mode }: { mode: ThemeMode }) {
  const palettes = mode === "system" ? ["light", "dark"] : [mode];
  return (
    <div className={`gyro-theme-preview is-${mode}`} aria-hidden="true">
      {palettes.map((palette) => (
        <div
          className={`gyro-theme-preview-workspace is-${palette}`}
          key={palette}
        >
          <div className="gyro-theme-preview-sidebar">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="gyro-theme-preview-main">
            <div className="gyro-theme-preview-lines">
              <i />
              <i />
              <i />
            </div>
            <div className="gyro-theme-preview-composer">
              <i />
              <i />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AppearanceColorControl({
  color,
  label,
  onChange,
}: {
  color: string;
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
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={color}
      />
      <span aria-hidden="true" className="gyro-color-swatch" />
      <code>{color.toUpperCase()}</code>
    </label>
  );
}
