import { Check, Users, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  normalizedCouncilConfig,
  readyCouncilProviders,
  type CouncilSeatResolution,
} from "./council";
import type { ModelPickerCopy, ReviewerOption } from "./composer-reviewer-picker";
import type { CouncilSynthesizerChoice, GyroConfig, ProviderStatus } from "./types";
import { ProviderLogo } from "./workspace-sidebar";
import type { ProviderId } from "./types";
import "./council-settings.css";

/** The action the composer sends to load or unload a Council preset. */
export const COUNCIL_TOGGLE_PRESET_ACTION = "council-toggle-preset:";

/**
 * The action that sets this chat's final-answer model. A JSON choice follows
 * the prefix; nothing after it goes back to the lead preset's model.
 */
export const COUNCIL_SYNTHESIZER_ACTION = "council-synthesizer:";

export function councilSynthesizerAction(choice?: CouncilSynthesizerChoice): string {
  return COUNCIL_SYNTHESIZER_ACTION + (choice ? JSON.stringify(choice) : "");
}

export function parseCouncilSynthesizerAction(
  action: string,
): CouncilSynthesizerChoice | null | undefined {
  if (!action.startsWith(COUNCIL_SYNTHESIZER_ACTION)) return undefined;
  const raw = action.slice(COUNCIL_SYNTHESIZER_ACTION.length);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CouncilSynthesizerChoice>;
    return typeof parsed.providerId === "string"
      ? { providerId: parsed.providerId, modelId: parsed.modelId ?? null }
      : null;
  } catch {
    return null;
  }
}

export const COUNCIL_WRITER_COPY: ModelPickerCopy = {
  title: "Who writes the final answer?",
  description:
    "Every loaded seat answers first. This model reads all of their answers and writes the one you get. Applies to this chat.",
  removeLabel: "Use the preset's model",
  emptyLabel: "Connect a provider in Settings → Models & accounts.",
};

/** Every model of every Council-ready provider, for the final-answer picker. */
export function councilWriterOptions(
  config: GyroConfig,
  statuses?: ProviderStatus[],
): ReviewerOption[] {
  return readyCouncilProviders(config, statuses).flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: model.displayName,
      providerLabel: provider.displayName,
      contextWindowTokens: model.contextWindowTokens,
    })),
  );
}

/**
 * The bar above a Council composer: which presets are loaded (toggle any of
 * them), which models that adds up to, and what one send costs.
 */
export function CouncilPreflight({
  config,
  resolution,
  enabled,
  costLabel,
  costTitle,
  onAction,
  onChooseWriter,
}: {
  config: GyroConfig;
  resolution: CouncilSeatResolution;
  enabled: boolean;
  costLabel?: string;
  costTitle?: string;
  onAction?: (action: string) => void;
  /** Opens the picker for the model that writes the final answer. */
  onChooseWriter?: () => void;
}) {
  const council = normalizedCouncilConfig(config.council);
  const loaded = new Set(council.activePresetIds ?? []);
  const blocked = Boolean(resolution.error) || !enabled;
  const named = (providerId: string, name: string) => (
    <span className="gyro-council-preflight-model" key={providerId}>
      <ProviderLogo providerId={providerId as ProviderId} label={name} />
      {name}
    </span>
  );
  const models = resolution.seats.map((seat, index) => (
    <span key={seat.providerId}>
      {index > 0 ? ", " : null}
      {named(seat.providerId, seat.modelLabel ?? seat.providerLabel ?? seat.providerId)}
    </span>
  ));
  const writerName = named(
    resolution.synthesizerProviderId,
    resolution.synthesizerModelLabel ??
      resolution.synthesizerProviderLabel ??
      resolution.synthesizerProviderId,
  );
  const writer = onChooseWriter ? (
    <button
      className="gyro-council-writer"
      onClick={onChooseWriter}
      title="Choose the model that writes the final answer"
      type="button"
    >
      {writerName}
      {council.synthesizer ? null : <em>preset</em>}
    </button>
  ) : (
    writerName
  );
  return (
    <div
      className={`gyro-council-preflight${blocked ? " is-blocked" : ""}`}
      role="status"
    >
      <Users aria-hidden="true" size={13} />
      <span className="gyro-council-preflight-presets" role="group" aria-label="Loaded Council presets">
        {council.presets.map((preset) => {
          const isLoaded = loaded.has(preset.id);
          return (
            <button
              aria-pressed={isLoaded}
              className={`gyro-council-preflight-preset${isLoaded ? " is-loaded" : ""}`}
              disabled={!onAction || (isLoaded && loaded.size === 1)}
              key={preset.id}
              onClick={() => onAction?.(`${COUNCIL_TOGGLE_PRESET_ACTION}${preset.id}`)}
              title={isLoaded ? `Unload ${preset.name}` : `Load ${preset.name}`}
              type="button"
            >
              {isLoaded ? <Check aria-hidden="true" size={10} /> : null}
              {preset.name}
            </button>
          );
        })}
      </span>
      <span className="gyro-council-preflight-summary">
        {!enabled
          ? "Model Council is off in Settings → Providers."
          : (resolution.error ?? <>Asks {models} · answered by {writer}</>)}
      </span>
      {!blocked && costLabel ? (
        <span className="gyro-council-preflight-cost" title={costTitle}>
          {costLabel}
        </span>
      ) : null}
    </div>
  );
}

export type CouncilScope = "turn" | "chat";

/**
 * Asked right after Council is picked: does it answer just the next message,
 * or every message in this chat? Esc or the close button keeps it to one turn.
 */
export function CouncilScopeDock({
  onChoose,
}: {
  onChoose: (scope: CouncilScope) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onChoose("turn");
  };
  return (
    <div
      aria-label="Use Council for the entire chat?"
      className="gyro-question-dock gyro-council-scope-dock"
      onKeyDown={onKeyDown}
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="gyro-question-dock-head">
        <Users aria-hidden="true" size={14} />
        <h3>Use Council for the entire chat?</h3>
        <button
          aria-label="Use for one turn"
          className="gyro-question-dock-close"
          onClick={() => onChoose("turn")}
          title="Use for one turn (Esc)"
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <div className="gyro-council-scope-actions">
        <button
          className="gyro-council-button is-quiet"
          onClick={() => onChoose("turn")}
          type="button"
        >
          Use One Turn
        </button>
        <button
          className="gyro-council-button is-primary"
          onClick={() => onChoose("chat")}
          type="button"
        >
          Use In This Chat
        </button>
      </div>
    </div>
  );
}
