import { useEffect, useState, type ReactNode } from "react";
import { Square, ChevronRight } from "./icons";
import subagentMark from "./assets/subagent-mark.png";
import { ChatRun } from "./chat-run-view";
import { buildRunModel, formatRunDuration } from "./chat-run";
import {
  isSubagentLive,
  sortedSubagents,
  subagentProcessEvents,
  subagentElapsedMs,
  subagentTokensLabel,
  subagentStatusLabel,
  subagentStatusCounts,
  subagentHue,
  type SubagentSnapshot,
  type SubagentSurfaceState,
} from "./subagents";
import type { SessionEvent } from "./types";
import { useChatTranscriptScroll } from "./use-chat-transcript-scroll";
const EMPTY_EVENTS: SessionEvent[] = [];

/** Keeps delegated work visible while the detailed process rail is closed. */
export function SubagentStrip({
  state,
  turnId,
}: {
  state: SubagentSurfaceState;
  turnId?: string;
}) {
  const agents = sortedSubagents(
    state.agents.filter(
      (agent) =>
        !turnId ||
        !agent.parentTurnId ||
        agent.parentTurnId === turnId ||
        isSubagentLive(agent),
    ),
  );
  if (!agents.length && !state.error && !state.isRefreshing) return null;
  return (
    <div className="gyro-subagent-dock">
      {agents.length ? (
        <details className="gyro-subagent-strip">
          <summary>
            <ChevronRight
              className="gyro-subagent-strip-chevron"
              size={12}
              aria-hidden="true"
            />
            <SubagentMarks agents={agents} />
            <span>
              {agents.length} {agents.length === 1 ? "sub-agent" : "sub-agents"}
            </span>
            <span className="gyro-subagent-strip-status" role="status">
              {subagentStatusCounts(agents).map(({ status, count, label }) => (
                <span
                  className={`gyro-subagent-status is-${status}`}
                  key={status}
                >
                  {count} {label}
                </span>
              ))}
            </span>
          </summary>
          <SubagentList agents={agents} state={state} />
        </details>
      ) : null}
      <SubagentRefreshNotice state={state} />
    </div>
  );
}

export function SubagentMark({ agentId }: { agentId: string }) {
  return (
    <img
      className="gyro-subagent-mark"
      src={subagentMark}
      alt=""
      aria-hidden="true"
      style={{ filter: `hue-rotate(${subagentHue(agentId)}deg)` }}
    />
  );
}

export function SubagentMarks({ agents }: { agents: SubagentSnapshot[] }) {
  return (
    <span className="gyro-subagent-marks" aria-hidden="true">
      {agents.slice(0, 4).map((agent) => (
        <SubagentMark key={agent.agentId} agentId={agent.agentId} />
      ))}
      {agents.length > 4 ? <small>+{agents.length - 4}</small> : null}
    </span>
  );
}

export function SubagentRefreshNotice({
  state,
}: {
  state: SubagentSurfaceState;
}) {
  if (state.isRefreshing) {
    return (
      <p className="gyro-subagent-empty" role="status">
        Loading sub-agents…
      </p>
    );
  }
  return state.error ? (
    <SubagentNotice
      message={state.error}
      detail={state.errorDetail}
      onRetry={state.onRefresh}
    />
  ) : null;
}

function SubagentNotice({
  message,
  detail,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="gyro-subagent-notice">
      <p role="alert">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
      {detail ? (
        <details>
          <summary>Details</summary>
          <p>{detail}</p>
        </details>
      ) : null}
    </div>
  );
}

function SubagentElapsed({ agent }: { agent: SubagentSnapshot }) {
  const live = isSubagentLive(agent);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return (
    <span title="Total elapsed time across runs">
      {formatRunDuration(Math.floor(subagentElapsedMs(agent, now) / 1_000))}
    </span>
  );
}

export function SubagentList({
  agents,
  state,
}: {
  agents: SubagentSnapshot[];
  state: SubagentSurfaceState;
}) {
  return (
    <section className="gyro-subagents" aria-label="Sub-agents">
      <ul>
        {agents.map((agent) => (
          <li key={agent.agentId}>
            <button
              type="button"
              onClick={() => state.onSelect(agent.agentId)}
              aria-label={`Open ${agent.name} · ${subagentStatusLabel(agent.status)}`}
              aria-current={
                state.selectedAgentId === agent.agentId || undefined
              }
              title={`${agent.name} · ${subagentStatusLabel(agent.status)}`}
              className={
                state.selectedAgentId === agent.agentId ? "is-selected" : ""
              }
            >
              <SubagentMark agentId={agent.agentId} />
              <strong className="gyro-subagent-name">{agent.name}</strong>
              <span className={`gyro-subagent-status is-${agent.status}`}>
                {subagentStatusLabel(agent.status)}
              </span>
              <ChevronRight
                className="gyro-subagent-open"
                size={12}
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SubagentPanel({
  state,
  renderAsk,
  renderSay,
  renderResponse,
}: {
  state?: SubagentSurfaceState;
  renderAsk: (event: SessionEvent) => ReactNode;
  renderSay: (text: string) => ReactNode;
  renderResponse: (text: string) => ReactNode;
}) {
  const agent = state?.agents.find(
    (item) => item.agentId === state.selectedAgentId,
  );
  const live = agent ? isSubagentLive(agent) : false;
  const events =
    (agent && state?.eventsByAgentId[agent.agentId]) ?? EMPTY_EVENTS;
  const scroll = useChatTranscriptScroll({
    events,
    hasMoreBefore: state?.history?.hasMoreBefore ?? false,
    isLoadingEarlier: state?.history?.isLoadingEarlier ?? false,
    onLoadEarlier: state?.history?.onLoadEarlier,
    liveChangesTarget: null,
  });
  if (!state || !agent)
    return (
      <div className="gyro-companion-empty">
        <strong>
          {state?.isRefreshing ? "Loading sub-agents…" : "No agent selected"}
        </strong>
        {state?.error ? <SubagentRefreshNotice state={state} /> : null}
        {!state?.isRefreshing && !state?.error ? (
          <span>
            Select a sub-agent from Environment or above the composer.
          </span>
        ) : null}
      </div>
    );
  const byRun = new Map<string, SessionEvent[]>();
  for (const event of events) {
    if (!event.turnId) continue;
    const run = byRun.get(event.turnId);
    if (run) run.push(event);
    else byRun.set(event.turnId, [event]);
  }
  const currentRun = byRun.get(agent.runId) ?? EMPTY_EVENTS;
  byRun.delete(agent.runId);
  const stop = state.onStop;
  const stopping = agent.status === "stopping";
  const requestingStop = Boolean(state.stopRequest?.pending);
  const canStop = Boolean(stop && live && !stopping && !requestingStop);
  return (
    <div className="gyro-subagent-panel">
      <header className="gyro-subagent-overview">
        <div className="gyro-subagent-heading">
          <SubagentMark agentId={agent.agentId} />
          <h2>{agent.name}</h2>
          {stop && live ? (
            <button
              className="gyro-subagent-stop"
              type="button"
              aria-label={`Stop ${agent.name}`}
              title={`Stop ${agent.name}`}
              disabled={!canStop}
              onClick={() => stop(agent.agentId)}
            >
              <Square size={11} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="gyro-subagent-metadata">
          <span
            className={`gyro-subagent-status is-${agent.status}`}
            role="status"
          >
            {requestingStop && !stopping && live
              ? "Requesting stop…"
              : subagentStatusLabel(agent.status)}
          </span>
          <SubagentElapsed agent={agent} />
          <span title="Cumulative usage across runs">
            {subagentTokensLabel(agent)}
          </span>
          {agent.readOnly ? <span>Read-only</span> : null}
        </div>
        {live && !stopping && state.stopRequest?.error ? (
          <SubagentNotice
            message="Could not stop the sub-agent."
            detail={state.stopRequest.error}
            onRetry={canStop && stop ? () => stop(agent.agentId) : undefined}
            retryLabel="Retry stop"
          />
        ) : null}
      </header>
      <div
        className="gyro-subagent-history"
        ref={scroll.transcriptRef}
        onScroll={scroll.onTranscriptScroll}
        onWheel={scroll.onTranscriptWheel}
        onTouchStart={scroll.onTranscriptTouchStart}
        onTouchMove={scroll.onTranscriptTouchMove}
        onKeyDown={scroll.onTranscriptKeyDown}
        onPointerDown={scroll.onTranscriptPointerDown}
      >
        {agent.task ? (
          <details className="gyro-subagent-task">
            <summary>Task</summary>
            <p>{agent.task}</p>
          </details>
        ) : null}
        {state.history?.hasMoreBefore ? (
          <button
            className="gyro-chat-load-earlier"
            type="button"
            disabled={state.history.isLoadingEarlier}
            onClick={() =>
              scroll.isLoadedChatClipped
                ? scroll.requestEarlierMessages(true)
                : state.history?.onLoadEarlier()
            }
          >
            {state.history.isLoadingEarlier
              ? "Loading earlier work…"
              : "Load earlier work"}
          </button>
        ) : null}
        {state.history?.isLoading ? (
          <p className="gyro-subagent-empty" role="status">
            Loading agent history…
          </p>
        ) : state.history?.error ? (
          <SubagentNotice
            message="Could not load agent history."
            detail={state.history.error}
            onRetry={state.history.onRetry}
          />
        ) : null}
        {[...byRun, [agent.runId, currentRun] as const].map(
          ([runId, rawEvents]) => {
            const current = runId === agent.runId;
            const runEvents = subagentProcessEvents(
              rawEvents,
              current &&
                (agent.status === "running" || agent.status === "waiting"),
            );
            const recorded = rawEvents.findLast((event) => {
              const payload = event.payload as
                { kind?: string; status?: string } | undefined;
              return payload?.kind === "provider-status" && payload.status;
            })?.payload as
              | {
                  status: string;
                  startedAt?: string;
                  durationMs?: number;
                  error?: string;
                }
              | undefined;
            const model = buildRunModel(runEvents, {
              isRunning: current && live,
              startedAt:
                recorded?.startedAt ??
                (current ? agent.startedAt : undefined) ??
                rawEvents[0]?.createdAt ??
                agent.createdAt,
              durationMs: recorded?.durationMs,
              status: current
                ? {
                    status:
                      agent.status === "completed" ? "done" : agent.status,
                    error: agent.error ?? undefined,
                  }
                : recorded,
            });
            const result =
              model.response?.message ?? (current ? agent.summary : undefined);
            const showRun = Boolean(
              model.steps.length ||
              recorded ||
              (current && (live || agent.error)),
            );
            if (!showRun && !result) return null;
            const previousTask =
              !current &&
              rawEvents.find((event) => event.kind === "user-message");
            return (
              <div className="gyro-chat-run gyro-subagent-run" key={runId}>
                {previousTask ? (
                  <details className="gyro-subagent-task">
                    <summary>Earlier task</summary>
                    <p>{previousTask.message}</p>
                  </details>
                ) : null}
                {showRun ? (
                  <ChatRun
                    model={model}
                    renderAsk={renderAsk}
                    renderSay={renderSay}
                    suppressThinkingIndicator={
                      current && agent.status !== "running"
                    }
                    statusLabel={
                      current && (stopping || agent.status === "waiting")
                        ? subagentStatusLabel(agent.status)
                        : undefined
                    }
                  />
                ) : null}
                {result ? (
                  <article className="gyro-subagent-result gyro-response-body">
                    {renderResponse(result)}
                  </article>
                ) : null}
              </div>
            );
          },
        )}
        {!live &&
        !events.some((event) => event.turnId) &&
        !agent.summary &&
        !agent.error &&
        !state.history?.isLoading &&
        !state.history?.error ? (
          <p className="gyro-subagent-empty">No work history recorded.</p>
        ) : null}
      </div>
    </div>
  );
}
