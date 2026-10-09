import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  CircleStop,
  LoaderCircle,
  Square,
  ChevronRight,
  Bot,
} from "lucide-react";
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
  subagentActivitySummary,
  type SubagentSnapshot,
  type SubagentSurfaceState,
} from "./subagents";
import type { SessionEvent } from "./types";
import { useChatTranscriptScroll } from "./use-chat-transcript-scroll";
import "./subagents.css";
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
  if (!agents.length) return null;
  const status = subagentActivitySummary(agents);
  return (
    <details className="gyro-subagent-strip">
      <summary
        aria-label={`${agents.length} ${agents.length === 1 ? "sub-agent" : "sub-agents"} · ${status.label}`}
      >
        <ChevronRight
          className="gyro-subagent-strip-chevron"
          size={12}
          aria-hidden="true"
        />
        <Bot size={14} aria-hidden="true" />
        <span>
          {agents.length} {agents.length === 1 ? "sub-agent" : "sub-agents"}
        </span>
        <span
          className={
            status.needsAttention
              ? "gyro-subagent-strip-status is-attention"
              : "gyro-subagent-strip-status"
          }
          role="status"
        >
          {status.label}
        </span>
      </summary>
      <SubagentList state={{ ...state, agents }} />
    </details>
  );
}

export function SubagentMark({ agentId }: { agentId: string }) {
  // Keep an agent's color stable across its list row and process panel.
  let hue = 0;
  for (const character of agentId)
    hue = (hue * 31 + character.charCodeAt(0)) % 360;
  return (
    <img
      className="gyro-subagent-mark"
      src={subagentMark}
      alt=""
      aria-hidden="true"
      style={{ filter: `hue-rotate(${hue}deg)` }}
    />
  );
}

function useAgentClock(agents: SubagentSnapshot[]) {
  const [, setNow] = useState(Date.now);
  const live = agents.some(isSubagentLive);
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return Date.now();
}

export function SubagentList({
  state,
  turnId,
  renderApproval,
}: {
  state: SubagentSurfaceState;
  turnId?: string;
  renderApproval?: (agentId: string) => ReactNode;
}) {
  const agents = sortedSubagents(
    state.agents.filter((agent) => !turnId || agent.parentTurnId === turnId),
  );
  const now = useAgentClock(agents);
  if (!agents.length) return null;
  return (
    <section className="gyro-subagents" aria-label="Sub-agents">
      <ul>
        {agents.map((agent) => (
          <li key={agent.agentId}>
            <button
              type="button"
              onClick={() => state.onSelect(agent.agentId)}
              aria-label={`Open ${agent.name} working process · ${subagentStatusLabel(agent.status)}`}
              title={`${agent.name} · ${subagentStatusLabel(agent.status)}`}
              className={
                state.selectedAgentId === agent.agentId ? "is-selected" : ""
              }
            >
              <span
                className={`gyro-subagent-status-icon is-${agent.status}`}
                aria-hidden="true"
              >
                {agent.status === "completed" ? (
                  <CheckCircle2 size={13} />
                ) : agent.status === "failed" ||
                  agent.status === "interrupted" ? (
                  <CircleAlert size={13} />
                ) : agent.status === "waiting" ? (
                  <Clock3 size={13} />
                ) : agent.status === "cancelled" ||
                  agent.status === "stopping" ? (
                  <CircleStop size={13} />
                ) : (
                  <LoaderCircle size={13} />
                )}
              </span>
              <strong className="gyro-subagent-name">{agent.name}</strong>
              <span className={`gyro-subagent-status is-${agent.status}`}>
                {subagentStatusLabel(agent.status)}
              </span>
              <span className="gyro-subagent-runtime">
                {formatRunDuration(
                  Math.floor(subagentElapsedMs(agent, now) / 1_000),
                )}
              </span>
              <span
                className="gyro-subagent-tokens"
                title="Cumulative tokens across this agent’s runs. Usage updates when reported by the provider."
              >
                {subagentTokensLabel(agent)}
              </span>
            </button>
            {renderApproval?.(agent.agentId)}
          </li>
        ))}
      </ul>
      {state.error ? <p role="alert">{state.error}</p> : null}
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
  const now = useAgentClock(agent ? [agent] : []);
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
      <div className="gyro-subagent-empty">
        Select a sub-agent from Environment or Working process.
      </div>
    );
  const runIds = [
    ...new Set(
      events
        .map((event) => event.turnId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!runIds.includes(agent.runId)) runIds.push(agent.runId);
  return (
    <div
      className="gyro-subagent-panel"
      ref={scroll.transcriptRef}
      onScroll={scroll.onTranscriptScroll}
      onWheel={scroll.onTranscriptWheel}
      onTouchStart={scroll.onTranscriptTouchStart}
      onTouchMove={scroll.onTranscriptTouchMove}
      onKeyDown={scroll.onTranscriptKeyDown}
      onPointerDown={scroll.onTranscriptPointerDown}
    >
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
      <details className="gyro-subagent-task">
        <summary>Task</summary>
        <p>{agent.task}</p>
      </details>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {runIds.map((runId) => {
        const rawEvents = events.filter((event) => event.turnId === runId);
        const runEvents = subagentProcessEvents(rawEvents);
        const recorded = [...rawEvents]
          .reverse()
          .find((event) =>
            [
              "provider-status",
              "provider-run",
              "provider-diagnostics",
            ].includes(
              String((event.payload as Record<string, unknown>)?.kind),
            ),
          )?.payload as
          | { status?: string; startedAt?: string; durationMs?: number }
          | undefined;
        const current = runId === agent.runId;
        const model = buildRunModel(runEvents, {
          isRunning: current && isSubagentLive(agent),
          startedAt:
            recorded?.startedAt ??
            (current ? agent.startedAt : undefined) ??
            rawEvents[0]?.createdAt ??
            agent.createdAt,
          durationMs:
            recorded?.durationMs ??
            (current && !isSubagentLive(agent) ? agent.elapsedMs : undefined),
          status: current
            ? {
                status: agent.status === "completed" ? "done" : agent.status,
                error: agent.error ?? undefined,
              }
            : recorded?.status
              ? { status: recorded.status }
              : undefined,
        });
        return (
          <div className="gyro-chat-run gyro-subagent-run" key={runId}>
            <ChatRun
              model={model}
              renderAsk={renderAsk}
              renderSay={renderSay}
              headerActions={
                current ? (
                  <>
                    <span
                      className="gyro-run-token-count"
                      title={`Cumulative usage · ${formatRunDuration(Math.floor(subagentElapsedMs(agent, now) / 1_000))}`}
                    >
                      {subagentTokensLabel(agent)}
                    </span>
                    {isSubagentLive(agent) ? (
                      <button
                        className="gyro-subagent-stop"
                        type="button"
                        aria-label={`Stop ${agent.name}`}
                        title="Stop agent"
                        disabled={agent.status === "stopping"}
                        onClick={() => state.onStop(agent.agentId)}
                      >
                        <Square size={11} aria-hidden="true" />
                      </button>
                    ) : null}
                  </>
                ) : undefined
              }
              statusLabel={
                current && agent.status === "waiting"
                  ? "Waiting for approval"
                  : undefined
              }
            />
            {model.response ? (
              <article className="gyro-subagent-result gyro-response-body">
                {renderResponse(model.response.message)}
              </article>
            ) : null}
          </div>
        );
      })}
      {agent.summary &&
      !events.some((event) => event.kind === "assistant-message") ? (
        <article className="gyro-subagent-result gyro-response-body">
          {renderResponse(agent.summary)}
        </article>
      ) : null}
    </div>
  );
}
