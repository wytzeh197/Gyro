import React, { useLayoutEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ComposerEffortSelector } from "./composer-effort-selector";
import { SelectionTrack } from "./selection-track";
import {
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
} from "./settings-controls";
import { useDialogDismiss } from "./use-dialog-dismiss";
import type { InterfaceSize, MotionSpeed, WorkbenchDensity } from "./types";

function FixtureDialog({ onClose }: { onClose: () => void }) {
  const { ref, dismiss } = useDialogDismiss(onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Motion preview"
      className="gyro-terminal-terminate-overlay"
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
    >
      <section className="gyro-terminal-terminate-card">
        <h2>Motion preview</h2>
        <p>This fixture contains no live project or provider data.</p>
        <button autoFocus onClick={dismiss}>
          Close preview
        </button>
      </section>
    </div>
  );
}

export function SizingMotionFixture() {
  const [theme, setTheme] = useState("dark");
  const [size, setSize] = useState<InterfaceSize>("default");
  const [density, setDensity] = useState<WorkbenchDensity>("comfortable");
  const [speed, setSpeed] = useState<MotionSpeed>("default");
  const [mode, setMode] = useState("Sessions");
  const [index, setIndex] = useState(2);
  const [single, setSingle] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [commits, setCommits] = useState<number[]>([]);
  const [pressSample, setPressSample] = useState("Not pressed");
  const [activations, setActivations] = useState(0);
  useLayoutEffect(() => {
    Object.assign(document.documentElement.dataset, {
      theme,
      interfaceSize: size,
      density,
      motionSpeed: speed,
    });
  }, [theme, size, density, speed]);
  return (
    <main className="gyro-motion-fixture">
      <h1>Sizing and motion QA</h1>
      <p>
        Development fixture. Check selection, dragging, keyboard input,
        wrapping, and dialog dismissal.
      </p>
      <SettingsRow label="Theme" detail="Both supported palettes.">
        <SettingsSegmented
          label="Fixture theme"
          value={theme}
          onChange={setTheme}
          options={[
            { label: "Dark", value: "dark" },
            { label: "Light", value: "light" },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Interface size"
        detail="Keeps the existing font and control scale choices."
      >
        <SettingsSegmented
          label="Fixture size"
          value={size}
          onChange={setSize}
          options={[
            { label: "Small", value: "small" },
            { label: "Default", value: "default" },
            { label: "Large", value: "large" },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Density"
        detail="Rows stay readable and multiline descriptions can grow."
      >
        <SettingsSegmented
          label="Fixture density"
          value={density}
          onChange={setDensity}
          options={[
            { label: "Compact", value: "compact" },
            { label: "Comfortable", value: "comfortable" },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Animation speed"
        detail="Use repeated selections to check interrupted transitions."
      >
        <SettingsSegmented
          label="Fixture speed"
          value={speed}
          onChange={setSpeed}
          options={[
            { label: "Slower", value: "slower" },
            { label: "Default", value: "default" },
            { label: "Faster", value: "faster" },
          ]}
        />
      </SettingsRow>
      <section className="gyro-motion-fixture-controls">
        <SelectionTrack
          className="gyro-settings-segmented"
          label="Variable-width selection"
          value={mode}
        >
          {["Sessions", "Workspace and review", "Provider settings"].map(
            (label) => (
              <button
                key={label}
                aria-pressed={mode === label}
                className={mode === label ? "is-active" : ""}
                onClick={() => setMode(label)}
              >
                {label}
              </button>
            ),
          )}
        </SelectionTrack>
        <SettingsSwitch
          checked={enabled}
          label="Preview switch"
          onChange={setEnabled}
        />
        <button onClick={() => setDialog(true)}>Open dialog</button>
        <button
          onClick={() => {
            setSingle(!single);
            setIndex(0);
          }}
        >
          Toggle single effort
        </button>
      </section>
      <section
        className="gyro-motion-fixture-controls"
        aria-label="Press feedback checks"
      >
        <button
          className="gyro-primary-button"
          onPointerDown={(event) => {
            const button = event.currentTarget;
            const glyph = button.querySelector("svg")!;
            const rect = button.getBoundingClientRect();
            setPressSample(
              JSON.stringify({
                opacity: getComputedStyle(button).opacity,
                glyphTranslate: getComputedStyle(glyph).translate,
                buttonTransform: getComputedStyle(button).transform,
                width: rect.width,
                height: rect.height,
              }),
            );
          }}
          onClick={() => setActivations((current) => current + 1)}
        >
          <ChevronRight size={16} />
          Preview action
        </button>
        <button disabled>
          <ChevronRight size={16} /> Disabled action
        </button>
        <output aria-label="Press feedback sample">{pressSample}</output>
        <output aria-label="Action activation count">
          Actions: {activations}
        </output>
      </section>
      <div className="gyro-composer-control-model gyro-motion-fixture-effort">
        <ComposerEffortSelector
          id="fixture-effort"
          labels={single ? ["Default"] : ["Low", "Medium", "High", "Maximum"]}
          selectedIndex={index}
          placement="down"
          onSelect={(next) => {
            setIndex(next);
            setCommits((current) => [...current, next]);
          }}
        />
      </div>
      <output aria-label="Saved effort choices">
        Saved choices: {commits.length}; last: {commits.at(-1) ?? "none"}
      </output>
      {dialog ? <FixtureDialog onClose={() => setDialog(false)} /> : null}
    </main>
  );
}
