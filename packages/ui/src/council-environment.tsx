import { Check, ChevronDown, ChevronUp, Users } from "lucide-react";
import { useId, useState } from "react";
import { normalizedCouncilConfig, type CouncilSeatResolution } from "./council";
import {
  COUNCIL_TOGGLE_PRESET_ACTION,
  councilSynthesizerAction,
} from "./council-composer";
import type { ReviewerOption } from "./composer-reviewer-picker";
import type { GyroConfig, ProviderId, SessionEvent } from "./types";
import { ProviderLogo } from "./workspace-sidebar";
import "./council-environment.css";

type LiveStatus = "queued" | "running" | "done" | "failed";

/** Where the latest Council run is, read from its council-* events. */
export type CouncilLiveProgress = {
  runId: string;
  finished: boolean;
  seats: Map<string, LiveStatus>;
  synthesis?: LiveStatus;
};

function payloadOf(event: SessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function councilLiveProgress(
  events: SessionEvent[] | undefined,
): CouncilLiveProgress | undefined {
  if (!events?.length) return undefined;
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === "council-run-started") {
      start = index;
      break;
    }
  }
  if (start < 0) return undefined;
  const started = payloadOf(events[start]!);
  const runId = String(started.councilRunId ?? "");
  const seats = new Map<string, LiveStatus>();
  for (const id of Array.isArray(started.seatProviderIds) ? started.seatProviderIds : []) {
    if (typeof id === "string") seats.set(id, "queued");
  }
  const providerBySeat = new Map<string, string>();
  const progress: CouncilLiveProgress = { runId, finished: false, seats };
  for (const event of events.slice(start + 1)) {
    const payload = payloadOf(event);
    if (String(payload.councilRunId ?? "") !== runId) continue;
    const seatId = String(payload.seatId ?? "");
    switch (event.kind) {
      case "council-seat-started": {
        const providerId = String(payload.providerId ?? "");
        providerBySeat.set(seatId, providerId);
        seats.set(providerId, "running");
        break;
      }
      case "council-seat-completed":
      case "council-seat-failed": {
        const providerId = providerBySeat.get(seatId);
        if (providerId) {
          seats.set(providerId, event.kind === "council-seat-completed" ? "done" : "failed");
        }
        break;
      }
      case "council-synthesis-started":
        progress.synthesis = "running";
        break;
      case "council-synthesis-completed":
        progress.synthesis = payload.error ? "failed" : "done";
        break;
      case "council-run-completed":
      case "council-run-cancelled":
        progress.finished = true;
        break;
      default:
        break;
    }
  }
  return progress;
}

const STATUS_COPY: Record<LiveStatus, string> = {
  queued: "waiting",
  running: "answering…",
  done: "done",
  failed: "failed",
};

function ModelName({ providerId, label }: { providerId: string; label: string }) {
  return (
    <span className="gyro-council-env-model">
      <ProviderLogo providerId={providerId as ProviderId} label={label} />
      <span className="gyro-env-card-ellipsis">{label}</span>
    </span>
  );
}

/**
 * The Council section of the Environment card. Folded, it is one row like the
 * branch row; open, it holds the loaded presets, the seats, who writes the
 * final answer and whether Council stays on for the whole chat. While a
 * Council turn runs, each seat shows where it is.
 */
export function CouncilEnvironmentSection({
  config,
  resolution,
  enabled,
  costLabel,
  calls,
  scope,
  progress,
  writerOptions,
  open,
  onOpenChange,
  onAction,
}: {
  config: GyroConfig;
  resolution: CouncilSeatResolution;
  enabled: boolean;
  costLabel?: string;
  calls: number;
  scope: "turn" | "chat";
  progress?: CouncilLiveProgress;
  writerOptions: ReviewerOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction?: (action: string) => void;
}) {
  const bodyId = useId();
  const [pickingWriter, setPickingWriter] = useState(false);
  const council = normalizedCouncilConfig(config.council);
  const loaded = new Set(council.activePresetIds ?? []);
  const blocked = !enabled || Boolean(resolution.error);
  const live = progress && !progress.finished ? progress : undefined;
  const writerLabel =
    resolution.synthesizerModelLabel ??
    resolution.synthesizerProviderLabel ??
    resolution.synthesizerProviderId;
  const seats = resolution.seats.map((seat) => ({
    providerId: seat.providerId,
    label: seat.modelLabel ?? seat.providerLabel ?? seat.providerId,
  }));
  // A running turn lists the seats it actually started with.
  const liveSeats = live
    ? [...live.seats.keys()].map(
        (providerId) =>
          seats.find((seat) => seat.providerId === providerId) ?? {
            providerId,
            label:
              config.modelProviders.find((provider) => provider.id === providerId)
                ?.displayName ?? providerId,
          },
      )
    : seats;
  const answered = live
    ? [...live.seats.values()].filter((status) => status === "done" || status === "failed").length
    : 0;
  const trailing = live
    ? live.synthesis === "running"
      ? "Writing answer…"
      : `${answered}/${live.seats.size} answered`
    : blocked
      ? "Not ready"
      : `${calls} calls`;
  const summary = !enabled
    ? "Council · off in Settings"
    : resolution.error
      ? `Council · ${resolution.error}`
      : `Council · ${resolution.presetName}`;
  const chooseWriter = (option?: ReviewerOption) => {
    onAction?.(
      councilSynthesizerAction(
        option ? { providerId: option.providerId, modelId: option.modelId } : undefined,
      ),
    );
    setPickingWriter(false);
  };
  return (
    <div className={`gyro-council-env${open ? " is-open" : ""}${live ? " is-live" : ""}`}>
      <div className="gyro-env-panel-rows">
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="gyro-env-panel-row gyro-council-env-row"
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <Users aria-hidden="true" size={13} />
          <span className="gyro-env-card-grow gyro-env-card-ellipsis">{summary}</span>
          <span
            className={`gyro-env-card-mono${live ? "" : " is-dim"}`}
            title={blocked ? undefined : `Answered by ${writerLabel}`}
          >
            {live ? <span aria-hidden="true" className="gyro-env-card-dot is-accent" /> : null}
            {!live && !blocked ? (
              <ProviderLogo
                providerId={resolution.synthesizerProviderId as ProviderId}
                label={writerLabel}
              />
            ) : null}
            {trailing}
          </span>
          {open ? <ChevronUp aria-hidden="true" size={13} /> : <ChevronDown aria-hidden="true" size={13} />}
        </button>
      </div>
      <div className="gyro-council-env-body" hidden={!open} id={bodyId}>
        <div className="gyro-council-env-presets" role="group" aria-label="Loaded Council presets">
          {council.presets.map((preset) => {
            const isLoaded = loaded.has(preset.id);
            return (
              <button
                aria-pressed={isLoaded}
                className={`gyro-council-preflight-preset${isLoaded ? " is-loaded" : ""}`}
                disabled={!onAction || Boolean(live) || (isLoaded && loaded.size === 1)}
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
        </div>
        {blocked ? (
          <p className="gyro-council-env-note">
            {!enabled ? "Model Council is off in Settings → Providers." : resolution.error}
          </p>
        ) : (
          <>
            <div className="gyro-council-env-label">Asks</div>
            <ul className="gyro-council-env-seats" aria-live="polite">
              {liveSeats.map((seat) => {
                const status = live?.seats.get(seat.providerId);
                return (
                  <li key={seat.providerId} className={status ? `is-${status}` : undefined}>
                    <ModelName providerId={seat.providerId} label={seat.label} />
                    {status ? (
                      <span className="gyro-council-env-status">
                        <span aria-hidden="true" className="gyro-council-env-dot" />
                        {STATUS_COPY[status]}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="gyro-council-env-label">Answered by</div>
            {live ? (
              <ul className="gyro-council-env-seats">
                <li className={live.synthesis ? `is-${live.synthesis}` : "is-queued"}>
                  <ModelName providerId={resolution.synthesizerProviderId} label={writerLabel} />
                  <span className="gyro-council-env-status">
                    <span aria-hidden="true" className="gyro-council-env-dot" />
                    {live.synthesis === "running"
                      ? "writing the final answer…"
                      : live.synthesis
                        ? STATUS_COPY[live.synthesis]
                        : "waits for the seats"}
                  </span>
                </li>
              </ul>
            ) : (
              <>
                <button
                  aria-expanded={pickingWriter}
                  className="gyro-council-env-writer"
                  disabled={!onAction}
                  onClick={() => setPickingWriter((value) => !value)}
                  title="Choose the model that writes the final answer"
                  type="button"
                >
                  <ModelName providerId={resolution.synthesizerProviderId} label={writerLabel} />
                  {council.synthesizer ? null : <em>preset</em>}
                  <ChevronDown aria-hidden="true" size={12} />
                </button>
                {pickingWriter ? (
                  <ul className="gyro-council-env-options" role="listbox" aria-label="Final-answer model">
                    {council.synthesizer ? (
                      <li>
                        <button className="is-reset" onClick={() => chooseWriter()} type="button">
                          Use the preset's model
                        </button>
                      </li>
                    ) : null}
                    {writerOptions.map((option) => {
                      const selected =
                        option.providerId === resolution.synthesizerProviderId &&
                        option.modelId === (resolution.synthesizerModelId ?? option.modelId);
                      return (
                        <li key={`${option.providerId}:${option.modelId}`}>
                          <button
                            aria-selected={selected}
                            onClick={() => chooseWriter(option)}
                            role="option"
                            type="button"
                          >
                            <ModelName providerId={option.providerId} label={option.label} />
                            {selected ? <Check aria-hidden="true" size={12} /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </>
            )}
          </>
        )}
        <div className="gyro-council-env-foot">
          <div className="gyro-council-env-scope" role="radiogroup" aria-label="Council applies to">
            {(["turn", "chat"] as const).map((value) => (
              <button
                aria-checked={scope === value}
                className={scope === value ? "is-selected" : undefined}
                disabled={!onAction}
                key={value}
                onClick={() => onAction?.(value === "chat" ? "council-scope-chat" : "council-scope-turn")}
                role="radio"
                type="button"
              >
                {value === "chat" ? "Whole chat" : "This turn"}
              </button>
            ))}
          </div>
          {!blocked && costLabel ? (
            <span className="gyro-council-env-cost gyro-env-card-ellipsis" title={costLabel}>
              {costLabel}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
