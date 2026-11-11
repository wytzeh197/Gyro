import type { WorkflowDefinition, WorkflowStep } from "./types";
import { useRef, useState } from "react";
import { WorkflowInputEditor, WorkflowStepEditor } from "./editor-fields";
import { uniqueName, newAgent } from "./editor-model";
export { emptyWorkflow } from "./editor-model";
export function WorkflowEditor({
  initial,
  existing,
  onSave,
  onCancel,
  busy,
  error,
}: {
  initial: WorkflowDefinition;
  existing: boolean;
  onSave: (definition: WorkflowDefinition) => void;
  onCancel: () => void;
  busy: boolean;
  error?: string;
}) {
  const [definition, setDefinition] = useState(() => structuredClone(initial));
  const [autoId, setAutoId] = useState(!existing);
  const steps = definition.steps;
  const editorRef = useRef<HTMLElement>(null);
  const [showErrors, setShowErrors] = useState(false);
  const incomplete = !definition.name.trim() || steps.some((step) => !step.instructions.trim());
  function save() {
    setShowErrors(true);
    if (incomplete) {
      requestAnimationFrame(() => editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    onSave(definition);
  }
  function setSteps(next: WorkflowStep[]) {
    setDefinition((current) => ({
      ...current,
      steps: next,
      roles: [
        ...new Set(
          next.flatMap((step) =>
            step.kind === "verification" ? [] : [step.role],
          ),
        ),
      ],
      completion: {
        ...current.completion,
        requiredOutputs: next.flatMap((step) =>
          step.kind === "agent" && step.output.required
            ? [step.output.name]
            : [],
        ),
        requireReviewCompletion:
          next.some((step) => step.kind === "review") &&
          current.completion.requireReviewCompletion,
        requireVerificationSuccess:
          next.some((step) => step.kind === "verification") &&
          current.completion.requireVerificationSuccess,
      },
    }));
  }
  const changeStep = (index: number, step: WorkflowStep) => {
    if (step.kind === "agent" && steps[index]?.kind !== "agent") {
      step = {
        ...step,
        output: {
          ...step.output,
          name: uniqueName(
            "output",
            steps.flatMap((existing) =>
              existing.kind === "agent" ? [existing.output.name] : [],
            ),
          ),
        },
      };
    }
    setSteps(
      steps.map((current, position) => (index === position ? step : current)),
    );
  };
  return (
    <section ref={editorRef} className="gyro-workflow-editor" aria-label="Workflow editor">
      <h2>{existing ? "Edit workflow" : "New workflow"}</h2>
      <p>
        Describe the steps you want to reuse. Choose models and project commands
        when you run it.
      </p>
      <fieldset className="gyro-workflow-editor-body" disabled={busy}>
        <h3 className="gyro-workflow-section-title">1. Name your workflow</h3>
        <label>
          Name
          <input
            autoFocus
            placeholder="e.g. Review my changes"
            aria-invalid={showErrors && !definition.name.trim() || undefined}
            value={definition.name}
            onChange={(event) =>
              setDefinition((current) => ({
                ...current,
                name: event.target.value,
                id: autoId
                  ? event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-|-$/g, "")
                  : current.id,
              }))
            }
          />
        </label>
        <details>
          <summary>Workflow identifier</summary>
          <label>
            Workflow ID
            <input
              disabled={existing}
              value={definition.id}
              onChange={(event) => {
                setAutoId(false);
                setDefinition((current) => ({
                  ...current,
                  id: event.target.value,
                }));
              }}
            />
          </label>
        </details>
        {showErrors && !definition.name.trim() ? <p className="gyro-workflow-field-error">Give your workflow a name.</p> : null}
        <label>
          Description (optional)
          <textarea
            aria-label="Description"
            placeholder="When should you use this workflow?"
            value={definition.description}
            onChange={(event) =>
              setDefinition((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
        </label>
        <h3 className="gyro-workflow-section-title">2. Arrange the steps</h3>
        <p className="gyro-workflow-muted">Steps run in order. Keep each one focused on a clear outcome.</p>
        <ol className="gyro-workflow-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <WorkflowStepEditor
                step={step}
                showErrors={showErrors}
                earlier={steps.slice(0, index)}
                onChange={(next) => changeStep(index, next)}
              />
              <div className="gyro-workflow-actions">
                <button
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...steps];
                    [next[index - 1], next[index]] = [
                      next[index]!,
                      next[index - 1]!,
                    ];
                    setSteps(next);
                  }}
                >
                  Move up
                </button>
                <button
                  disabled={index === steps.length - 1}
                  onClick={() => {
                    const next = [...steps];
                    [next[index + 1], next[index]] = [
                      next[index]!,
                      next[index + 1]!,
                    ];
                    setSteps(next);
                  }}
                >
                  Move down
                </button>
                <button
                  disabled={steps.length === 1}
                  onClick={() =>
                    setSteps(steps.filter((_, position) => position !== index))
                  }
                >
                  Remove step
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button
          disabled={steps.length >= 12}
          onClick={() => {
            const step = newAgent(1);
            step.id = uniqueName(
              "step",
              steps.map((step) => step.id),
            );
            if (step.kind === "agent")
              step.output.name = uniqueName(
                "output",
                steps.flatMap((step) =>
                  step.kind === "agent" ? [step.output.name] : [],
                ),
              );
            setSteps([...steps, step]);
          }}
        >
          Add step
        </button>
        <details className="gyro-workflow-advanced" open={definition.inputs.length > 0 || undefined}>
          <summary>Inputs · values you provide each time ({definition.inputs.length})</summary>
          <p className="gyro-workflow-muted">Add inputs for details that change between runs, such as a URL or a problem to investigate.</p>
        {definition.inputs.map((input, index) => (
          <WorkflowInputEditor
            key={index}
            input={input}
            onChange={(next) =>
              setDefinition((current) => ({
                ...current,
                inputs: current.inputs.map((input, position) =>
                  position === index ? next : input,
                ),
              }))
            }
            onRemove={() =>
              setDefinition((current) => ({
                ...current,
                inputs: current.inputs.filter(
                  (_, position) => position !== index,
                ),
              }))
            }
          />
        ))}
        <button
          disabled={definition.inputs.length >= 20}
          onClick={() =>
            setDefinition((current) => ({
              ...current,
              inputs: [
                ...current.inputs,
                {
                  id: uniqueName(
                    "input",
                    current.inputs.map((input) => input.id),
                  ),
                  label: "",
                  type: "string",
                  required: true,
                },
              ],
            }))
          }
        >
          Add input
        </button>
        </details>
        <details className="gyro-workflow-advanced">
        <summary>Completion requirements</summary>
        <label className="gyro-workflow-check">
          <input
            type="checkbox"
            disabled={!steps.some((step) => step.kind === "review")}
            checked={definition.completion.requireReviewCompletion}
            onChange={(event) =>
              setDefinition((current) => ({
                ...current,
                completion: {
                  ...current.completion,
                  requireReviewCompletion: event.target.checked,
                },
              }))
            }
          />
          Require complete review coverage
        </label>
        <label className="gyro-workflow-check">
          <input
            type="checkbox"
            disabled={!steps.some((step) => step.kind === "verification")}
            checked={definition.completion.requireVerificationSuccess}
            onChange={(event) =>
              setDefinition((current) => ({
                ...current,
                completion: {
                  ...current.completion,
                  requireVerificationSuccess: event.target.checked,
                },
              }))
            }
          />
          Require successful verification
        </label>
        </details>
      </fieldset>
      {showErrors && incomplete ? <p role="alert">Add a name and instructions for every step before saving.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="gyro-workflow-actions gyro-workflow-editor-footer">
        <span className="gyro-workflow-muted">Saving does not start a run.</span>
        <button
          className="gyro-primary-button"
          disabled={busy}
          onClick={save}
        >
          {busy ? "Saving…" : "Save workflow"}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Discard changes
        </button>
      </div>
    </section>
  );
}
