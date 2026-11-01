import { useRef, useState } from "react";
import type { WorkbenchPreferences } from "./types";
import { SettingsGroup } from "./settings-controls";
import {
  exportSettingsTransfer,
  parseSettingsTransfer,
  type PortableSettings,
} from "./settings-transfer";

export function SettingsTransferPanel({
  preferences,
  onApply,
}: {
  preferences: WorkbenchPreferences;
  onApply: (settings: Partial<PortableSettings>) => void;
}) {
  const importGeneration = useRef(0);
  const [draft, setDraft] = useState<Partial<PortableSettings>>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <SettingsGroup
      id="settings-transfer"
      label="Settings export/import"
      description="Move appearance, notifications and shortcuts between installations. Accounts, permissions, projects and chats are excluded."
    >
      <div className="gyro-settings-transfer-actions">
        <button
          className="gyro-secondary-button"
          type="button"
          onClick={() => {
            const blob = new Blob([exportSettingsTransfer(preferences)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "gyro-settings.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export settings
        </button>
        <label className="gyro-secondary-button">
          Import settings
          <input
            aria-label="Import settings file"
            type="file"
            accept=".json,application/json"
            onChange={async (event) => {
              const generation = ++importGeneration.current;
              const file = event.target.files?.[0];
              event.target.value = "";
              setDraft(undefined);
              setError("");
              setNotice("");
              if (!file) return;
              try {
                if (file.size > 65536)
                  throw new Error("Settings files must be smaller than 64 KB.");
                const parsed = parseSettingsTransfer(await file.text());
                if (generation === importGeneration.current) setDraft(parsed);
              } catch (e) {
                if (generation === importGeneration.current)
                  setError(String(e instanceof Error ? e.message : e));
              }
            }}
          />
        </label>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {draft ? (
        <div className="gyro-settings-import-preview">
          <h3>Review settings changes</h3>
          <p>Only these settings will be replaced.</p>
          <dl>
            {Object.entries(draft).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {key
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (c) => c.toUpperCase())}
                </dt>
                <dd>
                  <span>
                    Current:{" "}
                    {JSON.stringify(
                      preferences[key as keyof WorkbenchPreferences],
                    ) ?? "Default"}
                  </span>
                  <br />
                  <span>Import: {JSON.stringify(value)}</span>
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="gyro-primary-button"
            onClick={() => {
              onApply(draft);
              setDraft(undefined);
              setNotice("Settings applied.");
            }}
          >
            Apply settings
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={() => setDraft(undefined)}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </SettingsGroup>
  );
}
