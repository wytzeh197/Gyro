import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { SubagentList, SubagentMarks, SubagentNotice } from "./subagents-view";
import {
  subagentActivitySummary,
  subagentsForStatus,
  type SubagentSurfaceState,
} from "./subagents";

export function SubagentsEnvironment({
  state,
}: {
  state: SubagentSurfaceState;
}) {
  const [selected, setSelected] = useState<"working" | "done">();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const working = subagentsForStatus(state.agents, "working");
  const done = subagentsForStatus(state.agents, "done");
  const view = selected ?? (working.length ? "working" : "done");
  const agents = view === "working" ? working : done;
  const attention = state.agents.filter((agent) =>
    ["waiting", "failed", "interrupted"].includes(agent.status),
  );
  if (!state.agents.length && !state.error) return null;
  return (
    <section className="gyro-subagent-environment" aria-label="Subagents">
      <header>
        <span>Subagents</span>
        {attention.length ? (
          <button
            type="button"
            className="gyro-subagent-attention"
            onClick={() => {
              setSelected(
                attention.some((agent) => agent.status === "waiting")
                  ? "working"
                  : "done",
              );
              setExpanded(true);
            }}
          >
            {subagentActivitySummary(attention).label}
          </button>
        ) : null}
      </header>
      {state.agents.length ? (
        <>
          <div
            className="gyro-subagent-filters"
            role="group"
            aria-label="Subagent status"
          >
            {(["working", "done"] as const).map((status) => (
              <button
                type="button"
                key={status}
                aria-pressed={view === status}
                className={view === status ? "is-active" : undefined}
                aria-controls={listId}
                onClick={() => {
                  setSelected(status);
                  setExpanded(true);
                }}
              >
                {status === "working" ? "Working" : "Done"}{" "}
                <span>
                  {status === "working" ? working.length : done.length}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="gyro-subagent-environment-summary"
            aria-label={`${expanded ? "Hide" : "Show"} ${view} sub-agents, ${agents.length}`}
            title={`${expanded ? "Hide" : "Show"} ${view} sub-agents`}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((current) => !current)}
          >
            <SubagentMarks agents={agents} />
            <span role="status">
              {agents.length} {view}
            </span>
            <ChevronRight
              size={13}
              aria-hidden="true"
              className={expanded ? "is-expanded" : undefined}
            />
          </button>
          <div id={listId} hidden={!expanded}>
            {agents.length ? (
              <SubagentList state={{ ...state, agents, error: undefined }} />
            ) : (
              <p className="gyro-subagent-empty" role="status">
                No {view} sub-agents.
              </p>
            )}
          </div>
        </>
      ) : null}
      <SubagentNotice state={state} />
    </section>
  );
}
