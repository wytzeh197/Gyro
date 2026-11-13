import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bug,
  FileText,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Search,
  Workflow,
} from "lucide-react";
import type {
  WorkflowDefinition,
  WorkflowLibrary,
  WorkflowDraft,
  WorkflowListing,
} from "./types";
import { starterWorkflow, workflowStarters } from "./editor-model";

const starterIcons = [GitPullRequest, Bug, BookOpen];

export function WorkflowLibraryPanel({
  library,
  drafts,
  busy,
  onNew,
  onEdit,
  onSetup,
  onDraft,
}: {
  library?: WorkflowLibrary;
  drafts: WorkflowDraft[];
  busy: boolean;
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
          Loading workflows…
        </p>
      ) : !library.definitions.length ? (
        <section
          className="gyro-workflow-get-started"
          aria-label="Create your first workflow"
        >
          <div className="gyro-workflow-hero">
            <div className="gyro-workflow-intro">
              <span className="gyro-workflow-icon-tile is-large">
                <Workflow size={20} aria-hidden="true" />
              </span>
              <div>
                <h2>A useful task, ready to repeat</h2>
                <p>
                  Write the instructions once. Choose a model and run them
                  whenever you need.
                </p>
              </div>
            </div>
            <ol className="gyro-workflow-how">
              <li>
                <span>1</span>
                <div>
                  <strong>Describe the task</strong>
                  <small>Start from an example or a blank workflow.</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Arrange the steps</strong>
                  <small>Add work, a review, or a verification task.</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Save and reuse</strong>
                  <small>Run it on demand or set up a schedule.</small>
                </div>
              </li>
            </ol>
          </div>
          <div className="gyro-workflow-section-head">
            <h3>Start with an example</h3>
            <p>
              Examples open as editable drafts. Nothing runs until you choose to
              start it.
            </p>
          </div>
          <div className="gyro-workflow-starters">
            {workflowStarters.map((starter, index) => {
              const Icon = starterIcons[index] ?? FileText;
              return (
                <button
                  key={starter.name}
                  disabled={busy}
                  onClick={() => onNew(starterWorkflow(index))}
                >
                  <span className="gyro-workflow-icon-tile">
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <strong>{starter.name}</strong>
                  <span>{starter.description}</span>
                  <small>
                    Customize workflow{" "}
                    <ArrowRight size={14} aria-hidden="true" />
                  </small>
                </button>
              );
            })}
          </div>
        </section>
      ) : (
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
                      <button
                        className="gyro-primary-button"
                        onClick={() => onSetup(item)}
                      >
                        Run workflow…
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
      )}
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
    </>
  );
}
