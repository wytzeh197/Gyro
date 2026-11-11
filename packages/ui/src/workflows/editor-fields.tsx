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
}: {
  step: WorkflowStep;
  earlier: WorkflowStep[];
  onChange: (step: WorkflowStep) => void;
}) {
  return (
    <fieldset>
      <legend>{step.id}</legend>
      <label>
        Step ID
        <input
          value={step.id}
          onChange={(event) => onChange({ ...step, id: event.target.value })}
        />
      </label>
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
                  ? {
                      ...common,
                      kind: "review",
                      role: "reviewer",
                      sourceStep: "",
                    }
                  : {
                      ...common,
                      kind: "verification",
                      commandRef: "focused-tests",
                    },
            );
          }}
        >
          <option value="agent">Agent</option>
          <option value="review">Second-opinion review</option>
          <option value="verification">Verification task</option>
        </select>
      </label>
      {step.kind !== "verification" ? (
        <label>
          Role
          <input
            value={step.role}
            onChange={(event) =>
              onChange({ ...step, role: event.target.value })
            }
          />
        </label>
      ) : (
        <label>
          Command binding name
          <input
            value={step.commandRef}
            onChange={(event) =>
              onChange({ ...step, commandRef: event.target.value })
            }
          />
        </label>
      )}
      {step.kind === "review" ? (
        <label>
          Change from earlier step
          <select
            value={step.sourceStep}
            onChange={(event) =>
              onChange({ ...step, sourceStep: event.target.value })
            }
          >
            <option value="">Choose an earlier agent step</option>
            {earlier
              .filter((step) => step.kind === "agent")
              .map((step) => (
                <option key={step.id} value={step.id}>
                  {step.id}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <label>
        Instructions
        <textarea
          value={step.instructions}
          maxLength={8192}
          onChange={(event) =>
            onChange({ ...step, instructions: event.target.value })
          }
        />
      </label>
      <p className="gyro-workflow-muted">
        Use {"{{input.id}}"} for a declared input. Input values remain task
        data.
      </p>
      {step.kind === "agent" ? (
        <>
          <label>
            Requested access
            <select
              value={step.requestedAccess}
              onChange={(event) =>
                onChange({
                  ...step,
                  requestedAccess: event.target.value as
                    "read-only" | "workspace",
                })
              }
            >
              <option value="read-only">Read only</option>
              <option value="workspace">
                Workspace under current approvals
              </option>
            </select>
          </label>
          <label>
            Output name
            <input
              value={step.output.name}
              onChange={(event) =>
                onChange({
                  ...step,
                  output: { ...step.output, name: event.target.value },
                })
              }
            />
          </label>
          <label className="gyro-workflow-check">
            <input
              type="checkbox"
              checked={step.output.required}
              onChange={(event) =>
                onChange({
                  ...step,
                  output: { ...step.output, required: event.target.checked },
                })
              }
            />
            Require this output
          </label>
        </>
      ) : null}
    </fieldset>
  );
}
