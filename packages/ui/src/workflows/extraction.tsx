import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDraft,
  WorkflowProject,
  WorkflowRuntime,
  WorkflowSetup,
  WorkflowSourceTurn,
} from "./types";
export function WorkflowExtractionPanel({
  runtime,
  project,
  turnId,
  onEdit,
  onClose,
  draft: initial,
}: {
  runtime: WorkflowRuntime;
  project: WorkflowProject;
  turnId?: string;
  onEdit: (definition: WorkflowDefinition) => void;
  onClose: () => void;
  draft?: WorkflowDraft;
}) {
  const [turns, setTurns] = useState<WorkflowSourceTurn[]>([]);
  const [selected, setSelected] = useState<string[]>(turnId ? [turnId] : []);
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<WorkflowDraft | undefined>(initial);
  const [setup, setSetup] = useState<WorkflowSetup>();
  const [providerId, setProvider] = useState("");
  const [modelId, setModel] = useState("");
  const [allowUnproven, setAllowUnproven] = useState(false);
  const [artifact, setArtifact] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const currentId = useRef(draft?.id);
  currentId.current = draft?.id;
  useEffect(() => {
    const sequence = ++generation.current;
    void Promise.all([
      runtime.extraction<WorkflowSourceTurn[]>(
        "turns",
        {},
        project.sessionId,
        project.rootId,
      ),
      runtime.run<WorkflowSetup>(
        "setup",
        {},
        project.sessionId,
        project.rootId,
      ),
    ])
      .then(([turns, setup]) => {
        if (sequence !== generation.current) return;
        setTurns(turns);
        setSetup(setup);
        if (!turnId && !initial)
          setSelected(turns.slice(-1).map((turn) => turn.turnId));
      })
      .catch((error) => {
        if (sequence === generation.current) setError(String(error));
      });
    return () => {
      generation.current++;
    };
  }, [runtime, project.sessionId, project.rootId, turnId, initial?.id]);
  const refresh = useCallback(async () => {
    const id = currentId.current;
    if (!id) return;
    const sequence = generation.current;
    try {
      const next = await runtime.extraction<WorkflowDraft>("get", {
        draftId: id,
      });
      if (sequence === generation.current && currentId.current === id)
        setDraft(next);
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    }
  }, [runtime]);
  useEffect(() => runtime.subscribe(() => void refresh()), [runtime, refresh]);
  useEffect(() => {
    if (!draft || !["queued", "running"].includes(draft.status)) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [draft?.id, draft?.status, refresh]);
  async function act(action: "capture" | "start" | "stop" | "delete") {
    const sequence = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await runtime.extraction<WorkflowDraft>(
        action,
        {
          turnIds: selected,
          brief,
          draftId: draft?.id,
          revision: draft?.revision,
          captureHash: draft?.captureHash,
          providerId,
          modelId,
          allowUnproven,
        },
        project.sessionId,
        project.rootId,
      );
      if (sequence !== generation.current) return;
      if (action === "delete") onClose();
      else {
        setDraft(result);
        setArtifact(undefined);
      }
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    } finally {
      if (sequence === generation.current) setBusy(false);
    }
  }
  async function inspect(action: "input" | "output") {
    if (!draft) return;
    const id = draft.id;
    const sequence = generation.current;
    try {
      const result = await runtime.extraction<{
        input?: string;
        output?: string;
      }>(action, { draftId: id });
      if (sequence === generation.current && currentId.current === id)
        setArtifact(result.input ?? result.output ?? "No output was captured.");
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    }
  }
  return (
    <section aria-label="Extract workflow">
      <h2>Save a workflow from this chat</h2>
      <p>
        {project.title} · {project.path}
      </p>
      <p>
        Choose a task to turn into reusable steps. Creating a draft uses your
        selected provider; you can edit it before saving.
      </p>
      {!draft ? (
        <fieldset disabled={busy}>
          <legend>Source task</legend>
          {turns.length ? (
            turns.map((turn) => (
              <label className="gyro-workflow-check" key={turn.turnId}>
                <input
                  type="checkbox"
                  checked={selected.includes(turn.turnId)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, turn.turnId]
                        : current.filter((id) => id !== turn.turnId),
                    )
                  }
                />
                <span>
                  {turn.request}
                  <small>
                    {turn.status ?? "unfinished"}
                    {!turn.hasAnswer ? " · no answer captured" : ""}
                  </small>
                </span>
              </label>
            ))
          ) : (
            <p>No source turns are available.</p>
          )}
          <label>
            What should be reusable?
            <textarea
              value={brief}
              maxLength={2000}
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>
          <button
            disabled={!selected.length || busy}
            onClick={() => void act("capture")}
          >
            Preview selected task
          </button>
        </fieldset>
      ) : (
        <>
          <p role="status">
            {draft.status} · {draft.capturedBytes.toLocaleString()} bytes ·
            input {draft.captureHash.slice(0, 12)}
          </p>
          <p>
            {draft.sourceComplete
              ? "Source task completed. The extracted recipe has not been run."
              : "Source task is unfinished or incomplete. This is an unproven draft."}
          </p>
          {draft.status === "preview" ? (
            <fieldset disabled={busy}>
              <legend>Choose a model to create the draft</legend>
              <label>
                Provider
                <select
                  value={providerId}
                  onChange={(event) => {
                    setProvider(event.target.value);
                    setModel("");
                  }}
                >
                  <option value="">Choose a provider…</option>
                  {setup?.providers.map((provider) => (
                    <option
                      value={provider.id}
                      key={provider.id}
                      disabled={!provider.enabled || !provider.reviewAvailable}
                    >
                      {provider.label} · {provider.transport}
                      {!provider.reviewAvailable
                        ? " · no-tool extraction unavailable"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input
                  value={modelId}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              {!draft.sourceComplete ? (
                <label className="gyro-workflow-check">
                  <input
                    type="checkbox"
                    checked={allowUnproven}
                    onChange={(event) => setAllowUnproven(event.target.checked)}
                  />
                  Extract an unproven draft from this source
                </label>
              ) : null}
              <button
                className="gyro-primary-button"
                disabled={
                  !providerId ||
                  !modelId.trim() ||
                  (!draft.sourceComplete && !allowUnproven) ||
                  busy
                }
                onClick={() => void act("start")}
              >
                Create draft · uses selected provider
              </button>
            </fieldset>
          ) : null}
          {["queued", "running"].includes(draft.status) ? (
            <button disabled={busy} onClick={() => void act("stop")}>
              Stop extraction
            </button>
          ) : null}
          {draft.error ? <p role="alert">{draft.error}</p> : null}
          {draft.status === "ready" && draft.definition ? (
            <button
              className="gyro-primary-button"
              onClick={() => onEdit(draft.definition!)}
            >
              Edit workflow draft
            </button>
          ) : null}
          <div className="gyro-workflow-actions">
            <button onClick={() => void inspect("input")}>
              Inspect exact input
            </button>
            <button onClick={() => void inspect("output")}>
              Inspect output
            </button>
            {!["queued", "running"].includes(draft.status) ? (
              <button disabled={busy} onClick={() => void act("delete")}>
                Delete private draft
              </button>
            ) : null}
          </div>
          {artifact ? <pre>{artifact}</pre> : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <button disabled={busy} onClick={onClose}>
        Back to workflows
      </button>
    </section>
  );
}
