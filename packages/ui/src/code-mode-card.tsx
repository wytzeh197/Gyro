import {
  Check,
  ChevronRight,
  CircleDashed,
  Layers,
  AlertCircle,
} from "lucide-react";
import type { SessionEvent } from "./types";
import { workflowDetails, workflowChildren, workflowState } from "./code-mode";
import "./code-mode.css";

export function CodeModeActivityCard({
  event,
  onAction,
}: {
  event: SessionEvent;
  onAction?: (action: string, event: SessionEvent) => void;
}) {
  const details = workflowDetails(event);
  const children = workflowChildren(event);
  const state = workflowState(event);
  if (!details) return null;
  return (
    <article
      className={`gyro-workflow is-${state.label.toLowerCase().replaceAll(" ", "-")}`}
    >
      <details className="gyro-workflow-disclosure">
        <summary>
          <span className="gyro-workflow-icon" aria-hidden="true">
            {state.busy ? (
              <CircleDashed size={16} />
            ) : state.label === "Done" ? (
              <Check size={16} />
            ) : (
              <AlertCircle size={16} />
            )}
          </span>
          <span className="gyro-workflow-heading">
            <strong>{details.label}</strong>
            <span>
              {state.counts.completed}{" "}
              {state.counts.completed === 1 ? "action" : "actions"} completed
              {state.counts.running ? ` · ${state.counts.running} running` : ""}
              {state.counts.failed ? ` · ${state.counts.failed} failed` : ""}
              {state.counts.denied ? ` · ${state.counts.denied} denied` : ""}
            </span>
          </span>
          <span
            className="gyro-workflow-status"
            role="status"
            aria-live="polite"
          >
            {state.label}
          </span>
          <ChevronRight
            className="gyro-workflow-chevron"
            size={14}
            aria-hidden="true"
          />
        </summary>
        <div className="gyro-workflow-body">
          {children.length ? (
            <ol className="gyro-workflow-steps">
              {children.map((child) => {
                const activity = child.payload as Record<string, unknown>;
                const resource = activity.resource as
                  { label?: string } | undefined;
                return (
                  <li key={String(activity.callId)}>
                    <span>
                      <strong>
                        {String(activity.summary ?? child.message)}
                      </strong>
                      {resource?.label ? <small>{resource.label}</small> : null}
                    </span>
                    <small>
                      {String(activity.status ?? "")}
                      {typeof activity.durationMs === "number"
                        ? ` · ${(activity.durationMs / 1000).toFixed(1)} s`
                        : ""}
                    </small>
                    {resource ? (
                      <button
                        type="button"
                        disabled={!onAction}
                        onClick={() => onAction?.("show-capability", child)}
                      >
                        Show
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p>No workspace actions recorded.</p>
          )}
          {state.outcome?.error ? (
            <p className="gyro-workflow-notice">
              {state.outcome.error.message ?? state.outcome.error.kind}
            </p>
          ) : null}
          {state.outcome?.warnings?.length ? (
            <p className="gyro-workflow-notice">
              Some work returned warnings. Review the details before continuing.
            </p>
          ) : null}
          {state.outcome?.truncated ? (
            <p className="gyro-workflow-notice">
              The returned result was shortened. Individual actions retain their
              evidence.
            </p>
          ) : null}
          {state.label === "Interrupted" ? (
            <p className="gyro-workflow-notice">
              This workflow ended before reporting a final result. Completed
              actions are retained.
            </p>
          ) : null}
          {state.outcome?.value !== undefined ? (
            <details>
              <summary>Returned result</summary>
              <pre>{JSON.stringify(state.outcome.value, null, 2)}</pre>
            </details>
          ) : null}
          <details className="gyro-workflow-technical">
            <summary>
              <Layers size={13} aria-hidden="true" />
              Technical details
            </summary>
            <pre>{details.source}</pre>
            {state.outcome ? (
              <pre>{JSON.stringify(state.outcome, null, 2)}</pre>
            ) : null}
          </details>
        </div>
      </details>
    </article>
  );
}
