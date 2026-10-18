import "./efficiency.css";
import { EfficiencyRoutingSettings } from "./efficiency-routing-settings";
import { useState } from "react";
import type { GyroConfig, EfficiencyConfig, PriceSnapshot } from "./types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "./settings-controls";
export const DEFAULT_EFFICIENCY: EfficiencyConfig = {
  enabled: true,
  experimental: false,
  profile: "standard",
  parallelAgents: false,
  prices: [],
};
export function EfficiencySettings({
  config,
  onChange,
  onRoute,
}: {
  config: GyroConfig;
  onChange?: (value: EfficiencyConfig) => Promise<void>;
  onRoute?: (phase: string, escalate: boolean) => Promise<void>;
}) {
  const value = config.efficiency ?? DEFAULT_EFFICIENCY;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({
    provider: "",
    model: "",
    date: new Date().toISOString().slice(0, 10),
    currency: "USD",
    input: "",
    cached: "",
    write: "",
    output: "",
  });
  async function save(next: EfficiencyConfig) {
    if (!onChange) return;
    setBusy(true);
    setError("");
    try {
      await onChange(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !onChange;
  return (
    <SettingsGroup label="Context & experiments">
      <SettingsRow
        label="Context efficiency"
        detail="Enable validated context improvements. Experiments remain separate; model and reasoning choices stay yours."
      >
        <SettingsSwitch
          label="Context efficiency"
          checked={value.enabled}
          disabled={disabled}
          onChange={(enabled) => void save({ ...value, enabled })}
        />
      </SettingsRow>
      <SettingsRow
        label="Efficiency experiments"
        detail="Try structured output, task checkpoints, retrieval and progress detection. Live task-cost evaluation is pending; experiments are off by default."
      >
        <SettingsSwitch
          label="Efficiency experiments"
          checked={value.experimental}
          disabled={disabled || !value.enabled}
          onChange={(experimental) => void save({ ...value, experimental })}
        />
      </SettingsRow>
      {value.experimental
        ? (
            [
              ["structuredEvidence", "Structured tool evidence"],
              ["cacheAssembly", "Stable request assembly"],
              ["taskState", "Task checkpoints"],
              ["repositoryRetrieval", "Repository retrieval"],
              ["progressDetection", "Repeated-work detection"],
            ] as const
          ).map(([key, label]) => (
            <SettingsRow
              key={key}
              label={label}
              detail="Experimental policy; evaluate independently before making it a default."
            >
              <SettingsSwitch
                label={label}
                checked={value[key] ?? true}
                disabled={disabled || !value.enabled}
                onChange={(enabled) => void save({ ...value, [key]: enabled })}
              />
            </SettingsRow>
          ))
        : null}
      <SettingsRow
        label="Task profile"
        detail="Applies only when no reasoning effort is selected and the model supports it."
      >
        <SettingsSelect
          aria-label="Task profile"
          disabled={disabled || !value.enabled}
          value={value.profile}
          onChange={(e) =>
            void save({
              ...value,
              profile: e.target.value as EfficiencyConfig["profile"],
            })
          }
        >
          <option value="routine">Routine</option>
          <option value="standard">Standard</option>
          <option value="deep">Deep</option>
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow
        label="Parallel agents"
        detail="Allow additional agents when useful. Explicit task instructions still take precedence."
      >
        <SettingsSwitch
          label="Parallel agents"
          checked={value.parallelAgents}
          disabled={disabled}
          onChange={(parallelAgents) => void save({ ...value, parallelAgents })}
        />
      </SettingsRow>
      <EfficiencyRoutingSettings
        value={value}
        onChange={(next) => void save(next)}
        onRoute={onRoute}
        disabled={disabled}
      />
      <SettingsRow
        label="Reset efficiency"
        detail="Restore defaults while preserving immutable price history."
      >
        <button
          className="gyro-secondary-button"
          disabled={disabled}
          onClick={() =>
            void save({ ...DEFAULT_EFFICIENCY, prices: value.prices })
          }
          type="button"
        >
          Reset
        </button>
      </SettingsRow>
      <SettingsRow
        label="API price snapshots"
        detail="Optional estimates in currency per million tokens. Subscription allowances are separate; missing prices stay unknown."
        value={`${value.prices.length} saved`}
      />
      <details className="gyro-efficiency-price-entry">
        <summary>Add price snapshot</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const rate = (s: string, optional = false) => {
              if (!s.trim() && optional) return null;
              const n = Number(s);
              if (
                !s.trim() ||
                !Number.isFinite(n) ||
                n < 0 ||
                !Number.isSafeInteger(Math.round(n * 1e6))
              )
                throw Error("Enter a finite nonnegative price");
              return Math.round(n * 1e6);
            };
            try {
              const snapshot: PriceSnapshot = {
                id: crypto.randomUUID(),
                provider: draft.provider.trim(),
                model: draft.model.trim(),
                effectiveDate: draft.date,
                currency: draft.currency.toUpperCase(),
                inputMicrosPerMillion: rate(draft.input)!,
                cachedMicrosPerMillion: rate(draft.cached, true),
                cacheWriteMicrosPerMillion: rate(draft.write, true),
                outputMicrosPerMillion: rate(draft.output)!,
              };
              void save({ ...value, prices: [...value.prices, snapshot] });
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {(
            [
              "provider",
              "model",
              "date",
              "currency",
              "input",
              "cached",
              "write",
              "output",
            ] as const
          ).map((key) => (
            <SettingsRow
              key={key}
              detail=""
              label={
                {
                  provider: "Provider ID",
                  model: "Model ID",
                  date: "Effective date",
                  currency: "Currency",
                  input: "Input price",
                  cached: "Cached input price",
                  write: "Cache write price",
                  output: "Output price",
                }[key]
              }
            >
              <input
                className="gyro-efficiency-input"
                aria-label={`Price snapshot ${key}`}
                type={key === "date" ? "date" : "text"}
                disabled={disabled}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </SettingsRow>
          ))}
          <button
            className="gyro-secondary-button"
            disabled={disabled}
            type="submit"
          >
            Add price snapshot
          </button>
        </form>
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </SettingsGroup>
  );
}
