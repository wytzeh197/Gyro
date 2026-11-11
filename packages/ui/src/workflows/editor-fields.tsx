import type { WorkflowInput, WorkflowStep } from "./types";
import { newAgent } from "./editor-model";
export function WorkflowInputEditor({
  input,
  onChange,
  onRemove,
}: {
  input: WorkflowInput;
  onChange: (input: WorkflowInput) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset>
      <legend>{input.label || "Input"}</legend>
      <label>
        Input ID
        <input
          value={input.id}
          onChange={(event) => onChange({ ...input, id: event.target.value })}
        />
      </label>
      <label>
        Label
        <input
          value={input.label}
          onChange={(event) =>
            onChange({ ...input, label: event.target.value })
          }
        />
      </label>
      <label>
        Type
        <select
          value={input.type}
          onChange={(event) =>
            onChange({
              ...input,
              type: event.target.value as WorkflowInput["type"],
              options: undefined,
            })
          }
        >
          {["string", "boolean", "enum", "url", "path"].map((type) => (
            <option value={type} key={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      {input.type === "enum" ? (
        <label>
          Options, one per line
          <textarea
            value={input.options?.join("\n") ?? ""}
            onChange={(event) =>
              onChange({ ...input, options: event.target.value.split("\n") })
            }
          />
        </label>
      ) : null}
      <label className="gyro-workflow-check">
        <input
          type="checkbox"
          checked={input.required}
          onChange={(event) =>
            onChange({ ...input, required: event.target.checked })
          }
        />
        Required
      </label>
      <button onClick={onRemove}>Remove input</button>
    </fieldset>
  );
}
export function WorkflowStepEditor({
  step,
  earlier,
  onChange,
  showErrors = false,
}: {
  step: WorkflowStep;
  earlier: WorkflowStep[];
  onChange: (step: WorkflowStep) => void;
  showErrors?: boolean;
}) {
  return (
    <fieldset className="gyro-workflow-step-fields">
      <legend>Step {earlier.length + 1}</legend>
      <label>
        Step kind
        <select
          value={step.kind}
          onChange={(event) => {
            const common = { id: step.id, instructions: step.instructions };
            onChange(
              event.target.value === "agent"
                ? { ...newAgent(1), ...common }
                : event.target.value === "review"
                  ? { ...common, kind: "review", role: "reviewer", sourceStep: "" }
                  : { ...common, kind: "verification", commandRef: "focused-tests" },
            );
          }}
        >
          <option value="agent">Task — ask a model to do the work</option>
          <option value="review">Review — get a second opinion</option>
          <option value="verification">Verify — run a project command</option>
        </select>
      </label>
      <label>
        Instructions
        <textarea
          placeholder="What should happen in this step? Describe the work and the result you want."
          value={step.instructions}
          maxLength={8192}
          aria-invalid={showErrors && !step.instructions.trim() || undefined}
          onChange={(event) => onChange({ ...step, instructions: event.target.value })}
        />
      </label>
      {showErrors && !step.instructions.trim() ? (
        <p className="gyro-workflow-field-error">Add instructions for this step.</p>
      ) : null}
      {step.kind === "verification" ? (
        <label>
          Command binding name
          <input value={step.commandRef} onChange={(event) => onChange({ ...step, commandRef: event.target.value })} />
          <small>Give this command a name. Choose the actual project command when you run the workflow.</small>
        </label>
      ) : null}
      {step.kind === "review" ? (
        <label>
          Change from earlier step
          <select value={step.sourceStep} onChange={(event) => onChange({ ...step, sourceStep: event.target.value })}>
            <option value="">Choose an earlier agent step</option>
            {earlier.filter((step) => step.kind === "agent").map((step) => (
              <option key={step.id} value={step.id}>{step.id}</option>
            ))}
          </select>
        </label>
      ) : null}
      {step.kind === "agent" ? (
        <label>
          Requested access
          <select value={step.requestedAccess} onChange={(event) => onChange({ ...step, requestedAccess: event.target.value as "read-only" | "workspace" })}>
            <option value="read-only">Read only</option>
            <option value="workspace">Workspace under current approvals</option>
          </select>
        </label>
      ) : null}
      <details className="gyro-workflow-advanced">
        <summary>Advanced step settings</summary>
        <label>
          Step ID
          <input value={step.id} onChange={(event) => onChange({ ...step, id: event.target.value })} />
        </label>
        {step.kind !== "verification" ? (
          <label>
            Role
            <input value={step.role} onChange={(event) => onChange({ ...step, role: event.target.value })} />
            <small>Steps with the same role share a model choice at run setup.</small>
          </label>
        ) : null}
        <p className="gyro-workflow-muted">Use {"{{input.id}}"} in instructions to include a value you provide at run time.</p>
        {step.kind === "agent" ? (
          <>
            <label>
              Output name
              <input value={step.output.name} onChange={(event) => onChange({ ...step, output: { ...step.output, name: event.target.value } })} />
            </label>
            <label className="gyro-workflow-check">
              <input type="checkbox" checked={step.output.required} onChange={(event) => onChange({ ...step, output: { ...step.output, required: event.target.checked } })} />
              Require this output
            </label>
          </>
        ) : null}
      </details>
    </fieldset>
  );
}
