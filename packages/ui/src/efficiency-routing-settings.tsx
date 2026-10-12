import { useState } from "react";
import type { EfficiencyConfig, EfficiencyRoute } from "./types";
import { SettingsRow, SettingsSwitch } from "./settings-controls";
export function EfficiencyRoutingSettings({
  value,
  onChange,
  onRoute,
  disabled,
}: {
  value: EfficiencyConfig;
  onChange: (next: EfficiencyConfig) => void;
  onRoute?: (phase: string, escalate: boolean) => Promise<void>;
  disabled: boolean;
}) {
  const policy = value.routing ?? {
    enabled: false,
    routes: [],
    escalation: null,
  };
  const [draft, setDraft] = useState({ phase: "", provider: "", model: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = (patch: Partial<typeof policy>) =>
    onChange({ ...value, routing: { ...policy, ...patch } });
  async function route(phase: string, escalate: boolean) {
    setBusy(true);
    setError("");
    try {
      await onRoute?.(phase, escalate);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SettingsRow
        label="Phase routing"
        detail="Configure optional model changes at task boundaries. Apply a route explicitly; escalation is limited to once per task."
      >
        <SettingsSwitch
          label="Phase routing"
          checked={policy.enabled}
          disabled={disabled || !value.enabled}
          onChange={(enabled) => save({ enabled })}
        />
      </SettingsRow>
      {policy.enabled ? (
        <>
          {policy.routes.map((r) => (
            <SettingsRow
              key={r.phase}
              label={r.phase}
              detail={`${r.provider} / ${r.model}`}
            >
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={disabled || busy || !onRoute}
                onClick={() => void route(r.phase, false)}
              >
                Apply to current chat
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={disabled}
                onClick={() =>
                  save({
                    routes: policy.routes.filter((x) => x.phase !== r.phase),
                  })
                }
              >
                Remove
              </button>
            </SettingsRow>
          ))}
          {policy.escalation ? (
            <SettingsRow
              label="Escalation"
              detail={`${policy.escalation.provider} / ${policy.escalation.model}`}
            >
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={disabled || busy || !onRoute}
                onClick={() => void route("escalation", true)}
              >
                Escalate current chat once
              </button>
            </SettingsRow>
          ) : null}
          {(["phase", "provider", "model"] as const).map((key) => (
            <SettingsRow
              key={key}
              label={`Route ${key}`}
              detail="Use a configured provider and model."
            >
              <input
                className="gyro-efficiency-input"
                aria-label={`Route ${key}`}
                value={draft[key]}
                disabled={disabled}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </SettingsRow>
          ))}
          <SettingsRow
            label="Save route"
            detail="Phase names are unique. Targets are checked against enabled models before a handoff."
          >
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={
                disabled ||
                !draft.phase.trim() ||
                !draft.provider.trim() ||
                !draft.model.trim() ||
                policy.routes.length >= 8
              }
              onClick={() => {
                const r: EfficiencyRoute = {
                  phase: draft.phase.trim(),
                  provider: draft.provider.trim(),
                  model: draft.model.trim(),
                };
                save({
                  routes: [
                    ...policy.routes.filter((x) => x.phase !== r.phase),
                    r,
                  ],
                });
              }}
            >
              Add phase
            </button>
            <button
              type="button"
              className="gyro-secondary-button"
              disabled={
                disabled || !draft.provider.trim() || !draft.model.trim()
              }
              onClick={() =>
                save({
                  escalation: {
                    phase: "escalation",
                    provider: draft.provider.trim(),
                    model: draft.model.trim(),
                  },
                })
              }
            >
              Set escalation target
            </button>
          </SettingsRow>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
