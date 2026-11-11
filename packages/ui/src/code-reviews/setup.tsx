import { useId, useState } from "react";
import type { CodeReviewScope, ReviewerSetup } from "./types";
export type ReviewSetupValues = {
  rootId?: string;
  scopeKind: CodeReviewScope["kind"];
  base: string;
  providerId: string;
  modelId: string;
  brief: string;
  paths: string;
};
export function ReviewSetupForm({
  setup,
  busy,
  value,
  turnId,
  onChange,
  onCapture,
}: {
  setup: ReviewerSetup;
  busy: boolean;
  value: ReviewSetupValues;
  turnId: string;
  onChange: (value: ReviewSetupValues) => void;
  onCapture: () => void;
}) {
  const {
    rootId: effectiveRoot,
    scopeKind,
    base,
    providerId,
    modelId,
    brief,
    paths,
  } = value;
  const modelListId = useId();
  const [optionsOpen, setOptionsOpen] = useState(scopeKind === "branch");
  const provider = setup.reviewers.find((item) => item.id === providerId);
  const root = setup.roots.find((item) => item.id === effectiveRoot);
  const scopeLabel =
    scopeKind === "turn"
      ? "This task’s changes"
      : scopeKind === "branch"
        ? `Branch changes${base ? ` against ${base}` : ""}`
        : "Uncommitted changes";
  const set = (field: keyof ReviewSetupValues, next: string) =>
    onChange({ ...value, [field]: next });
  return (
    <fieldset disabled={busy}>
      <legend>Choose a reviewer</legend>
      <p className="gyro-review-context" title={root?.path}>
        <strong>{scopeLabel}</strong>
        <span>
          {root?.path.split("/").filter(Boolean).at(-1) ?? "Project"}
          {paths.trim()
            ? ` · ${paths.split("\n").filter((path) => path.trim()).length} selected paths`
            : " · all changed files"}
        </span>
      </p>
      <label>
        Reviewer
        <select
          value={providerId}
          onChange={(event) => {
            onChange({ ...value, providerId: event.target.value, modelId: "" });
          }}
        >
          <option value="">Choose a reviewer…</option>
          {setup.reviewers.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.available}>
              {item.label}
              {item.reason ? ` — ${item.reason}` : ""}
            </option>
          ))}
        </select>
      </label>
      {!setup.reviewers.some((item) => item.available) ? (
        <p className="gyro-review-hint">
          Enable an API provider or local Ollama in Settings → Providers to get
          a second opinion.
        </p>
      ) : null}
      {provider ? (
        <>
          <label>
            Model
            <input
              list={modelListId}
              value={modelId}
              onChange={(event) => set("modelId", event.target.value)}
              placeholder={provider.defaultModelId ?? "Choose or enter a model"}
            />
            <datalist id={modelListId}>
              {provider.modelIds.map((id) => (
                <option value={id} key={id} />
              ))}
            </datalist>
          </label>
          <p className="gyro-review-hint">
            {provider.transport === "local"
              ? "Runs locally on your machine."
              : "Uses this provider’s API credentials and billing."}
          </p>
        </>
      ) : null}
      <details
        open={optionsOpen}
        onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
      >
        <summary>Options</summary>
        <div className="gyro-review-options">
          <label>
            Project
            <select
              value={effectiveRoot ?? ""}
              onChange={(event) => {
                set("rootId", event.target.value);
              }}
            >
              {setup.roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            Changes to review
            <select
              value={scopeKind}
              onChange={(event) => {
                set("scopeKind", event.target.value as CodeReviewScope["kind"]);
              }}
            >
              <option value="uncommitted">Uncommitted changes</option>
              <option value="branch">Branch against base</option>
              {turnId ? (
                <option value="turn">This task’s changes</option>
              ) : null}
            </select>
          </label>
          {scopeKind === "turn" ? (
            <p>
              Source task: <code>{turnId}</code>
            </p>
          ) : null}
          {scopeKind === "branch" ? (
            <label>
              Base branch or commit
              <input
                value={base}
                onChange={(event) => {
                  set("base", event.target.value);
                }}
              />
            </label>
          ) : null}
          <label>
            What should the reviewer focus on?
            <textarea
              value={brief}
              onChange={(event) => {
                set("brief", event.target.value);
              }}
              placeholder="Optional. Uses the task’s original request when available."
            />
          </label>
          <label>
            Limit to these file paths
            <textarea
              value={paths}
              onChange={(event) => {
                set("paths", event.target.value);
              }}
              placeholder="Optional, one relative path per line. Leave empty for all changed files."
            />
          </label>
        </div>
      </details>
      {scopeKind === "branch" && !base.trim() ? (
        <p className="gyro-review-hint">
          Choose a base branch in Options before previewing.
        </p>
      ) : null}
      <button
        className="gyro-review-primary"
        disabled={
          !provider?.available ||
          !modelId.trim() ||
          (scopeKind === "branch" && !base.trim())
        }
        onClick={onCapture}
      >
        {busy ? "Preparing preview…" : "Preview review"}
      </button>
    </fieldset>
  );
}
