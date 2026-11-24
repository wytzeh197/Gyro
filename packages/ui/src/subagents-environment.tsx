import { useId, useState } from "react";
import { ChevronRight } from "./icons";
import {
  SubagentList,
  SubagentMarks,
  SubagentRefreshNotice,
} from "./subagents-view";
import { subagentsForStatus, type SubagentSurfaceState } from "./subagents";

export function SubagentsEnvironment({
  autoExpand = false,
  state,
}: {
  /** Open the list without a click, e.g. while agents are working. */
  autoExpand?: boolean;
  state: SubagentSurfaceState;
}) {
  const [selected, setSelected] = useState<"working" | "done">();
  const [expandedToggle, setExpanded] = useState<boolean>();
  // Follows the caller until the user opens or closes the list by hand.
  const expanded = expandedToggle ?? autoExpand;
  const listId = useId();
  const working = subagentsForStatus(state.agents, "working");
  const done = subagentsForStatus(state.agents, "done");
  const view = selected ?? (working.length ? "working" : "done");
  const groupLabel = view === "working" ? "active" : "finished";
  const agents = view === "working" ? working : done;
  const approvals = working.filter(
    (agent) => agent.status === "waiting",
  ).length;
  const problems = done.filter(
    (agent) => agent.status === "failed" || agent.status === "interrupted",
  ).length;
  const show = (status: "working" | "done") => {
    setSelected(status);
    setExpanded(true);
  };
  if (!state.agents.length && !state.error && !state.isRefreshing) return null;
  return (
    <section className="gyro-subagent-environment" aria-label="Sub-agents">
      <header>
        <span>Sub-agents</span>
      </header>
      {state.agents.length ? (
        <>
          {approvals || problems ? (
            <div
              className="gyro-subagent-attention"
              aria-label="Sub-agent attention"
              role="group"
            >
              {approvals ? (
                <button
                  type="button"
                  className="gyro-subagent-status is-waiting"
                  aria-controls={listId}
                  onClick={() => show("working")}
                >
                  {approvals} {approvals === 1 ? "needs" : "need"} approval
                </button>
              ) : null}
              {problems ? (
                <button
                  type="button"
                  className={`gyro-subagent-status is-${done.some(({ status }) => status === "failed") ? "failed" : "interrupted"}`}
                  aria-controls={listId}
                  onClick={() => show("done")}
                >
                  {problems} {problems === 1 ? "needs" : "need"} attention
                </button>
              ) : null}
            </div>
          ) : null}
          <div
            className="gyro-subagent-filters"
            role="group"
            aria-label="Sub-agent status"
          >
            {(["working", "done"] as const).map((status) => (
              <button
                type="button"
                key={status}
                aria-pressed={view === status}
                className={view === status ? "is-active" : undefined}
                aria-controls={listId}
                onClick={() => show(status)}
              >
                {status === "working" ? "Active" : "Finished"}{" "}
                <span>
                  {status === "working" ? working.length : done.length}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="gyro-subagent-environment-summary"
            aria-label={`${expanded ? "Hide" : "Show"} ${groupLabel} sub-agents, ${agents.length}`}
            title={`${expanded ? "Hide" : "Show"} ${groupLabel} sub-agents`}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(!expanded)}
          >
            <SubagentMarks agents={agents} />
            <span role="status">
              {agents.length} {groupLabel}
            </span>
            <ChevronRight
              size={13}
              aria-hidden="true"
              className={expanded ? "is-expanded" : undefined}
            />
          </button>
          <div id={listId} hidden={!expanded}>
            {agents.length ? (
              <SubagentList agents={agents} state={state} />
            ) : (
              <p className="gyro-subagent-empty" role="status">
                No {groupLabel} sub-agents.
              </p>
            )}
          </div>
        </>
      ) : null}
      <SubagentRefreshNotice state={state} />
    </section>
  );
}
