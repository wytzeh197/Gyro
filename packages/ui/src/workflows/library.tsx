import { useState } from "react";
import { ArrowRight, MessageSquare, Plus, RefreshCw, Search, Workflow } from "lucide-react";
import type { WorkflowDefinition, WorkflowLibrary, WorkflowDraft, WorkflowListing } from "./types";
import { starterWorkflow, workflowStarters } from "./editor-model";
export function WorkflowLibraryPanel({
  library,
  drafts,
  busy,
  onNew,
  onExtract,
  onRefresh,
  onEdit,
  onSetup,
  onDraft,
}: {
  library?: WorkflowLibrary;
  drafts: WorkflowDraft[];
  busy: boolean;
  onNew: (definition?: WorkflowDefinition) => void;
  onExtract: () => void;
  onRefresh: () => void;
  onEdit: (item: WorkflowListing) => void;
  onSetup: (item: WorkflowListing) => void;
  onDraft: (draft: WorkflowDraft) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <>
      <div className="gyro-workflow-actions gyro-workflow-library-toolbar">
        <button className="gyro-primary-button" disabled={busy} onClick={() => onNew()}>
          <Plus size={16} aria-hidden="true" /> New workflow
        </button>
        <button disabled={busy} onClick={onExtract}>
          <MessageSquare size={16} aria-hidden="true" /> Create from a chat
        </button>
        <button
          onClick={onRefresh}
          aria-label="Refresh workflows"
          title="Refresh workflows"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {library?.definitions.length ? (
        <label className="gyro-workflow-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search workflows"
            placeholder="Search workflows…"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      {!library ? (
        <p role="status">Loading workflows…</p>
      ) : !library.definitions.length ? (
        <section className="gyro-workflow-get-started" aria-label="Create your first workflow">
          <div className="gyro-workflow-intro">
            <Workflow size={24} aria-hidden="true" />
            <div>
              <h2>A useful task, ready to repeat</h2>
              <p>Write the instructions once. Choose a model and run them whenever you need.</p>
            </div>
          </div>
          <ol className="gyro-workflow-how">
            <li><span>1</span><div><strong>Describe the task</strong><small>Start from an example or a blank workflow.</small></div></li>
            <li><span>2</span><div><strong>Arrange the steps</strong><small>Add work, a review, or a verification task.</small></div></li>
            <li><span>3</span><div><strong>Save and reuse</strong><small>Run it on demand or set up a schedule.</small></div></li>
          </ol>
          <h3>Start with an example</h3>
          <div className="gyro-workflow-starters">
            {workflowStarters.map((starter, index) => (
              <button key={starter.name} disabled={busy} onClick={() => onNew(starterWorkflow(index))}>
                <strong>{starter.name}</strong>
                <span>{starter.description}</span>
                <small>Customize workflow <ArrowRight size={14} aria-hidden="true" /></small>
              </button>
            ))}
          </div>
          <p className="gyro-workflow-muted">Examples open as editable drafts. Nothing runs until you choose to start it.</p>
        </section>
      ) : (
        <ul className="gyro-workflow-list">
          {library.definitions
            .filter((item) =>
              `${item.definition?.name ?? item.path} ${item.definition?.description ?? ""}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((item) => (
              <li key={item.path}>
                <strong>{item.definition?.name ?? item.path}</strong>
                {item.definition ? (
                  <>
                    <p>{item.definition.description}</p>
                    <p>{item.definition.steps.length} steps</p>
                    <div className="gyro-workflow-actions">
                      <button disabled={busy} onClick={() => onEdit(item)}>
                        Edit workflow
                      </button>
                      <button onClick={() => onSetup(item)}>
                        Run workflow…
                      </button>
                    </div>
                    <details>
                      <summary>File location</summary>
                      <code>{item.path}</code>
                    </details>
                  </>
                ) : (
                  <p role="status">Disabled: {item.diagnostic}</p>
                )}
              </li>
            ))}
        </ul>
      )}
      {query &&
      library?.definitions.length &&
      !library.definitions.some((item) =>
        `${item.definition?.name ?? item.path} ${item.definition?.description ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) ? (
        <p>No workflows match this search.</p>
      ) : null}
      {drafts.length ? (
        <details>
          <summary>Drafts from chats ({drafts.length})</summary>
          <ul className="gyro-workflow-list">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <strong>{draft.definition?.name ?? "Workflow draft"}</strong>
                <p>
                  {draft.status} ·{" "}
                  {draft.sourceComplete
                    ? "completed source task"
                    : "source task not completed"}
                </p>
                <button onClick={() => onDraft(draft)}>Review draft</button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
