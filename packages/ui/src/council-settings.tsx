import { useState } from "react";
import { Copy, Plus, RotateCcw, Trash2, X } from "./icons";
import {
  COUNCIL_MAX_SEATS,
  councilPresetProblem,
  isEditedBuiltInCouncilPreset,
  newCouncilPresetId,
  normalizedCouncilConfig,
  removeCouncilPreset,
  toggleCouncilActivePreset,
  upsertCouncilPreset,
} from "./council";
import {
  isPickerHiddenModel,
  providerDefaultModel,
} from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsChoice,
  SettingsSwitch,
} from "./settings-controls";
import type {
  CouncilConfig,
  CouncilPreset,
  GyroConfig,
  ModelProviderConfig,
  ProviderId,
} from "./types";
import { ProviderLogo } from "./workspace-sidebar";
import "./council-settings.css";

/**
 * Settings → Providers → Model Council.
 *
 * Lives outside `surfaces.tsx` (which is at its architecture ceiling). Presets
 * are saved into `config.council.presets`; a built-in preset is overridden by
 * keeping its id, so Reset only has to put the shipped copy back.
 */
export function CouncilSettings({
  config,
  providers,
  onConfigChange,
}: {
  config: GyroConfig;
  /** Every provider the app knows, connected or not. */
  providers: ModelProviderConfig[];
  onConfigChange?: (config: GyroConfig) => void;
}) {
  const council = normalizedCouncilConfig(config.council);
  const [selectedId, setSelectedId] = useState(
    () => council.activePresetIds?.[0] ?? council.presets[0]?.id ?? "",
  );
  /** A new preset being named, or an edit that cannot be saved yet. */
  const [pending, setPending] = useState<CouncilPreset | null>(null);
  const [pendingIsNew, setPendingIsNew] = useState(false);
  const save = (next: CouncilConfig) =>
    onConfigChange?.({ ...config, council: next });

  const selected =
    council.presets.find((preset) => preset.id === selectedId) ??
    council.presets[0];
  const shown =
    pending && (pendingIsNew || pending.id === selected?.id) ? pending : selected;
  const loaded = new Set(council.activePresetIds ?? []);

  const change = (next: CouncilPreset) => {
    if (pendingIsNew || councilPresetProblem(next)) {
      setPending(next);
      return;
    }
    setPending(null);
    save(upsertCouncilPreset(council, next));
  };
  const select = (id: string) => {
    setPending(null);
    setPendingIsNew(false);
    setSelectedId(id);
  };
  const startNew = (from?: CouncilPreset) => {
    const connected = providers.filter((p) => p.authStatus === "connected");
    const name = from ? `${from.name} copy` : "My council";
    setPendingIsNew(true);
    setPending({
      id: newCouncilPresetId(name, council.presets),
      name,
      seatProviderIds:
        from?.seatProviderIds.slice() ??
        connected.slice(0, 2).map((provider) => provider.id),
      seatModelIds: { ...(from?.seatModelIds ?? {}) },
      synthesizerProviderId:
        from?.synthesizerProviderId ?? connected[0]?.id ?? "anthropic",
      synthesizerModelId: from?.synthesizerModelId ?? null,
      toolPolicy: "none",
      builtIn: false,
    });
  };
  const create = () => {
    if (!pending || councilPresetProblem(pending)) return;
    save(upsertCouncilPreset(council, pending));
    setSelectedId(pending.id);
    setPending(null);
    setPendingIsNew(false);
  };

  return (
    <SettingsGroup label="Model Council" collapsible>
      <SettingsRow
        label="Enable Council"
        detail="Type /council to ask several models at once."
      >
        <SettingsSwitch
          label="Enable Council"
          checked={council.enabled}
          onChange={(enabled) => save({ ...council, enabled })}
        />
      </SettingsRow>
      {council.enabled ? (
        <>
          <div className="gyro-council-roles" data-setting-key="council-presets">
            <div className="gyro-council-tabs" role="tablist" aria-label="Council presets">
              {council.presets.map((preset) => (
                <button
                  aria-selected={!pendingIsNew && preset.id === selected?.id}
                  className="gyro-council-tab"
                  key={preset.id}
                  onClick={() => select(preset.id)}
                  role="tab"
                  title={loaded.has(preset.id) ? "Loaded in Council chats" : undefined}
                  type="button"
                >
                  {preset.name}
                  {loaded.has(preset.id) ? (
                    <span aria-label="loaded" className="gyro-council-tab-dot" />
                  ) : null}
                </button>
              ))}
              <button
                aria-label="New preset"
                aria-selected={pendingIsNew}
                className="gyro-council-tab is-add"
                onClick={() => startNew(shown)}
                role="tab"
                title="New preset"
                type="button"
              >
                <Plus aria-hidden="true" size={12} />
              </button>
            </div>
            {shown ? (
              <CouncilPresetEditor
                draft={shown}
                isLoaded={loaded.has(shown.id)}
                isNew={pendingIsNew}
                onCancel={() => {
                  setPending(null);
                  setPendingIsNew(false);
                }}
                onChange={change}
                onCreate={create}
                onRemove={() => {
                  setPending(null);
                  if (!shown.builtIn) setSelectedId(council.presets[0]?.id ?? "");
                  save(removeCouncilPreset(council, shown.id));
                }}
                onSaveAs={() => startNew(shown)}
                onToggleLoaded={() =>
                  save(toggleCouncilActivePreset(council, shown.id))
                }
                onlyLoaded={loaded.size === 1 && loaded.has(shown.id)}
                providers={providers}
              />
            ) : null}
          </div>
          <SettingsRow
            label="Answer if a model fails"
            detail="Combine the answers that did come back."
          >
            <SettingsSwitch
              label="Answer if a model fails"
              checked={council.synthesizeOnPartial}
              onChange={(synthesizeOnPartial) =>
                save({ ...council, synthesizeOnPartial })
              }
            />
          </SettingsRow>
        </>
      ) : null}
    </SettingsGroup>
  );
}

const SEAT_SEPARATOR = "\u0000";

/**
 * One select per seat: providers as groups, their models inside. The value
 * is `provider + SEP + model` ("" model = the provider's default).
 */
function SeatSelect({
  providers,
  providerId,
  modelId,
  exclude,
  label,
  onChange,
}: {
  providers: ModelProviderConfig[];
  providerId: string;
  modelId?: string | null;
  exclude?: string[];
  label: string;
  onChange: (providerId: string, modelId: string | null) => void;
}) {
  const options = providers
    .filter((provider) => !exclude?.includes(provider.id))
    .map((provider) => {
      const fallback = providerDefaultModel(provider);
      return {
        id: provider.id,
        label: provider.authStatus === "connected"
          ? provider.displayName
          : `${provider.displayName} (not connected)`,
        items: [
          {
            value: `${provider.id}${SEAT_SEPARATOR}`,
            label: fallback
              ? `${fallback.displayName} (default)`
              : `${provider.displayName} default`,
          },
          ...provider.models
            .filter((model) =>
              model.id !== fallback?.id &&
              ((provider.id === providerId && model.id === modelId) ||
                !isPickerHiddenModel(provider.id, model.id)),
            )
            .map((model) => ({
              value: `${provider.id}${SEAT_SEPARATOR}${model.id}`,
              label: model.displayName,
            })),
        ],
      };
    });
  return (
    <span className="gyro-council-seat-pick">
      <ProviderLogo providerId={providerId as ProviderId} />
      <SettingsChoice
        aria-label={label}
        onValueChange={(value) => {
          const [nextProvider = "", nextModel = ""] = value.split(SEAT_SEPARATOR);
          onChange(nextProvider, nextModel || null);
        }}
        value={`${providerId}${SEAT_SEPARATOR}${modelId ?? ""}`}
        options={options}
      />
    </span>
  );
}

function CouncilPresetEditor({
  draft,
  providers,
  isNew,
  isLoaded,
  onlyLoaded,
  onChange,
  onCreate,
  onCancel,
  onRemove,
  onSaveAs,
  onToggleLoaded,
}: {
  draft: CouncilPreset;
  providers: ModelProviderConfig[];
  isNew: boolean;
  isLoaded: boolean;
  onlyLoaded: boolean;
  onChange: (draft: CouncilPreset) => void;
  onCreate: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onSaveAs: () => void;
  onToggleLoaded: () => void;
}) {
  const problem = councilPresetProblem(draft);
  const seats = draft.seatProviderIds;
  const setSeat = (index: number, providerId: string, modelId: string | null) => {
    const next = seats.slice();
    const previous = next[index];
    next[index] = providerId;
    const seatModelIds = { ...(draft.seatModelIds ?? {}) };
    if (previous && previous !== providerId) delete seatModelIds[previous];
    seatModelIds[providerId] = modelId;
    onChange({ ...draft, seatProviderIds: next, seatModelIds });
  };
  const unused = providers.filter((provider) => !seats.includes(provider.id));
  return (
    <form
      className="gyro-council-editor"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isNew) onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (isNew && !problem) onCreate();
      }}
      role="tabpanel"
    >
      {isNew || !draft.builtIn ? (
        <input
          aria-label="Preset name"
          autoFocus={isNew}
          className="gyro-council-name"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          onFocus={(event) => {
            if (isNew) event.currentTarget.select();
          }}
          placeholder="Preset name"
          value={draft.name}
        />
      ) : draft.description ? (
        <p className="gyro-council-description">{draft.description}</p>
      ) : null}
      <div className="gyro-council-seats">
        <span className="gyro-council-label">Ask</span>
        <div className="gyro-council-seat-list">
          {seats.map((providerId, index) => (
            <div className="gyro-council-seat-row" key={`${index}-${providerId}`}>
              <SeatSelect
                exclude={seats.filter((id) => id !== providerId)}
                label={`Model ${index + 1}`}
                modelId={draft.seatModelIds?.[providerId]}
                onChange={(nextProvider, modelId) =>
                  setSeat(index, nextProvider, modelId)
                }
                providerId={providerId}
                providers={providers}
              />
              <button
                aria-label={`Remove model ${index + 1}`}
                className="gyro-council-icon-button"
                disabled={seats.length <= 1}
                onClick={() =>
                  onChange({
                    ...draft,
                    seatProviderIds: seats.filter((_, i) => i !== index),
                  })
                }
                title="Remove"
                type="button"
              >
                <X aria-hidden="true" size={13} />
              </button>
            </div>
          ))}
          {seats.length < COUNCIL_MAX_SEATS && unused.length > 0 ? (
            <button
              className="gyro-council-link"
              onClick={() =>
                onChange({
                  ...draft,
                  seatProviderIds: [
                    ...seats,
                    (
                      unused.find((p) => p.authStatus === "connected") ??
                      unused[0]!
                    ).id,
                  ],
                })
              }
              type="button"
            >
              <Plus aria-hidden="true" size={12} />
              Add model
            </button>
          ) : null}
        </div>
        <span className="gyro-council-label">Answer by</span>
        <div className="gyro-council-seat-row">
          <SeatSelect
            label="Model that writes the answer"
            modelId={draft.synthesizerModelId}
            onChange={(synthesizerProviderId, synthesizerModelId) =>
              onChange({ ...draft, synthesizerProviderId, synthesizerModelId })
            }
            providerId={draft.synthesizerProviderId}
            providers={providers}
          />
          <span />
        </div>
      </div>
      <div className="gyro-council-editor-footer">
        {isNew ? (
          <>
            <span className="gyro-council-problem">{problem ?? ""}</span>
            <button className="gyro-council-button is-quiet" onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className="gyro-council-button is-primary"
              disabled={Boolean(problem)}
              type="submit"
            >
              Save preset
            </button>
          </>
        ) : (
          <>
            <label className="gyro-council-check">
              <input
                checked={isLoaded}
                disabled={onlyLoaded}
                onChange={onToggleLoaded}
                type="checkbox"
              />
              Load in new chats
            </label>
            <span className="gyro-council-problem">{problem ?? ""}</span>
            {!draft.builtIn ? (
              <button className="gyro-council-button is-quiet" onClick={onRemove} type="button">
                <Trash2 aria-hidden="true" size={12} />
                Delete
              </button>
            ) : isEditedBuiltInCouncilPreset(draft) ? (
              <button className="gyro-council-button is-quiet" onClick={onRemove} type="button">
                <RotateCcw aria-hidden="true" size={12} />
                Reset
              </button>
            ) : null}
            <button className="gyro-council-button" onClick={onSaveAs} type="button">
              <Copy aria-hidden="true" size={12} />
              Save as preset
            </button>
          </>
        )}
      </div>
    </form>
  );
}
