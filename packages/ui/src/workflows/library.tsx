import { useState } from "react";
import { RefreshCw, Workflow } from "lucide-react";
import type { WorkflowLibrary, WorkflowDraft, WorkflowListing } from "./types";
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
  onNew: () => void;
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
        <button className="gyro-primary-button" onClick={onNew}>
          New workflow
        </button>
        {library?.definitions.length ? (
          <button onClick={onExtract}>Create from a chat</button>
        ) : null}
        <button
          onClick={onRefresh}
          aria-label="Refresh workflows"
          title="Refresh workflows"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {library?.definitions.length ? (
        <label>
          Search workflows
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      {!library ? (
        <p role="status">Loading workflows…</p>
      ) : !library.definitions.length ? (
        <div className="gyro-workflow-empty">
          <span className="gyro-workflow-empty-icon">
            <Workflow size={24} aria-hidden="true" />
          </span>
          <h2>Your next repeatable task starts here</h2>
          <p>
            Save a workflow to reuse its steps, or turn a completed chat into
            one.
          </p>
          <button onClick={onExtract}>Create from a chat</button>
          <small>No workflows saved in this project yet.</small>
        </div>
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
