import type { WorkflowDefinition, WorkflowStep } from "./types";
import { useState } from "react";
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
  const [autoId, setAutoId] = useState(!existing && !initial.id);
  const steps = definition.steps;
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
    <section className="gyro-workflow-editor" aria-label="Workflow editor">
      <h2>{existing ? "Edit workflow" : "New workflow"}</h2>
      <p>
        Describe the steps you want to reuse. Choose models and project commands
        when you run it.
      </p>
      <fieldset disabled={busy}>
        <label>
          Name
          <input
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
        <label>
          Description
          <textarea
            value={definition.description}
            onChange={(event) =>
              setDefinition((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
          />
        </label>
        <h3>Inputs</h3>
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
        <h3>Steps</h3>
        <ol className="gyro-workflow-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <WorkflowStepEditor
                step={step}
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
        <h3>Completion requirements</h3>
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
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      <div className="gyro-workflow-actions">
        <button
          className="gyro-primary-button"
          disabled={busy}
          onClick={() => onSave(definition)}
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
