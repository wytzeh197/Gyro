import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  BookOpen,
  Bug,
  AppWindow,
  Hammer,
  Wrench,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Search,
  Workflow,
} from "../icons";
import type {
  WorkflowDefinition,
  WorkflowLibrary,
  WorkflowDraft,
  WorkflowListing,
} from "./types";
import { starterWorkflow, workflowStarters } from "./editor-model";

const starterIcons = [GitPullRequest, Bug, BookOpen, Wrench, AppWindow, Hammer];

export function WorkflowLibraryPanel({
  library,
  drafts,
  busy,
  loadError,
  choosingSchedule,
  onNew,
  onEdit,
  onSetup,
  onDraft,
}: {
  library?: WorkflowLibrary;
  drafts: WorkflowDraft[];
  busy: boolean;
  loadError: boolean;
  choosingSchedule: boolean;
  onNew: (definition?: WorkflowDefinition) => void;
  onEdit: (item: WorkflowListing) => void;
  onSetup: (item: WorkflowListing) => void;
  onDraft: (draft: WorkflowDraft) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = (item: WorkflowListing) =>
    `${item.definition?.name ?? item.path} ${item.definition?.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const visible = library?.definitions.filter(matches) ?? [];
  return (
    <>
      {!library ? (
        <p className="gyro-workflow-muted" role="status">
          {loadError ? "Workflows couldn’t be loaded." : "Loading workflows…"}
        </p>
      ) : library.definitions.length ? (
        <section className="gyro-workflow-section" aria-label="Saved workflows">
          <div className="gyro-workflow-section-head is-row">
            <h2>
              Saved workflows{" "}
              <span className="gyro-workflow-count">
                {library.definitions.length}
              </span>
            </h2>
            <label className="gyro-workflow-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Search workflows"
                placeholder="Search workflows…"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {visible.length ? (
            <ul className="gyro-workflow-rows">
              {visible.map((item) => (
                <li
                  key={item.path}
                  className={item.definition ? undefined : "is-disabled"}
                >
                  <span className="gyro-workflow-icon-tile">
                    {item.definition ? (
                      <Workflow size={16} aria-hidden="true" />
                    ) : (
                      <AlertTriangle size={16} aria-hidden="true" />
                    )}
                  </span>
                  <div className="gyro-workflow-row-body">
                    <strong>{item.definition?.name ?? item.path}</strong>
                    {item.definition ? (
                      <>
                        {item.definition.description ? (
                          <p>{item.definition.description}</p>
                        ) : null}
                        <small>
                          <ListChecks size={12} aria-hidden="true" />
                          {item.definition.steps.length}{" "}
                          {item.definition.steps.length === 1
                            ? "step"
                            : "steps"}
                          <span aria-hidden="true">·</span>
                          <code title={item.path}>{item.path}</code>
                        </small>
                      </>
                    ) : (
                      <p role="status">Disabled: {item.diagnostic}</p>
                    )}
                  </div>
                  {item.definition ? (
                    <div className="gyro-workflow-row-actions">
                      <button disabled={busy} onClick={() => onEdit(item)}>
                        Edit workflow
                      </button>
                      <button disabled={busy} onClick={() => onSetup(item)}>
                        {choosingSchedule
                          ? "Schedule workflow…"
                          : "Run workflow…"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="gyro-workflow-inline-empty">
              No workflows match this search.
            </p>
          )}
        </section>
      ) : choosingSchedule ? (
        <p className="gyro-workflow-inline-empty">
          Save a workflow to schedule it.
        </p>
      ) : null}
      {drafts.length ? (
        <section
          className="gyro-workflow-section"
          aria-label="Drafts from chats"
        >
          <div className="gyro-workflow-section-head">
            <h2>
              Drafts from chats{" "}
              <span className="gyro-workflow-count">{drafts.length}</span>
            </h2>
          </div>
          <ul className="gyro-workflow-rows">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <span className="gyro-workflow-icon-tile">
                  <MessageSquare size={16} aria-hidden="true" />
                </span>
                <div className="gyro-workflow-row-body">
                  <strong>{draft.definition?.name ?? "Workflow draft"}</strong>
                  <small>
                    {draft.status} ·{" "}
                    {draft.sourceComplete
                      ? "source turn completed · recipe not yet verified"
                      : "source turn incomplete · unproven draft"}
                  </small>
                </div>
                <div className="gyro-workflow-row-actions">
                  <button onClick={() => onDraft(draft)}>Review draft</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {library ? (
        <section className="gyro-workflow-section" aria-label="Templates">
          <div className="gyro-workflow-section-head">
            <h2>Templates</h2>
            <p>Choose a template to open an editable draft.</p>
          </div>
          <ul className="gyro-workflow-rows">
            {workflowStarters.map((starter, index) => {
              const Icon = starterIcons[index] ?? Workflow;
              const definition = starterWorkflow(index);
              const steps = definition.steps
                .map((step) => {
                  if (step.kind === "verification") return "Verify";
                  if (step.kind === "review") return "Review";
                  return "Implement";
                })
                .join(" → ");
              return (
                <li key={starter.name} className="is-link">
                  <button
                    className="gyro-workflow-row gyro-workflow-template-row"
                    disabled={busy}
                    onClick={() => onNew(definition)}
                  >
                    <span className="gyro-workflow-icon-tile">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="gyro-workflow-row-body">
                      <strong>{starter.name}</strong>
                      <small>{starter.description}</small>
                    </span>
                    <small className="gyro-workflow-row-meta">
                      {definition.steps.length === 1
                        ? "Read-only · 1 step"
                        : steps}
                    </small>
                    <ChevronRight
                      className="gyro-workflow-row-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
