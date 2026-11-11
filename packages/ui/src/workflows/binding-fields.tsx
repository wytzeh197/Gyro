import { useId } from "react";
import type {
  WorkflowDefinition,
  WorkflowBinding,
  WorkflowSetup,
} from "./types";
export function WorkflowBindingFields({
  definition,
  binding,
  setup,
  change,
}: {
  definition: WorkflowDefinition;
  binding: WorkflowBinding;
  setup: WorkflowSetup;
  change: (binding: WorkflowBinding) => void;
}) {
  const id = useId();
  return (
    <>
      <h3>Task details</h3>
      {definition.inputs.length ? (
        definition.inputs.map((input) => (
          <label
            key={input.id}
            className={
              input.type === "boolean" ? "gyro-workflow-check" : undefined
            }
          >
            {input.type === "boolean" ? (
              <input
                type="checkbox"
                checked={binding.inputs[input.id] === true}
                onChange={(event) =>
                  change({
                    ...binding,
                    inputs: {
                      ...binding.inputs,
                      [input.id]: event.target.checked,
                    },
                  })
                }
              />
            ) : null}
            {input.label || input.id}
            {input.required ? " (required)" : ""}
            {input.type === "boolean" ? null : input.type === "enum" ? (
              <select
                value={String(binding.inputs[input.id] ?? "")}
                onChange={(event) =>
                  change({
                    ...binding,
                    inputs: {
                      ...binding.inputs,
                      [input.id]: event.target.value,
                    },
                  })
                }
              >
                <option value="">Choose a value</option>
                {input.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={input.type === "url" ? "url" : "text"}
                value={String(binding.inputs[input.id] ?? "")}
                onChange={(event) =>
                  change({
                    ...binding,
                    inputs: {
                      ...binding.inputs,
                      [input.id]: event.target.value,
                    },
                  })
                }
              />
            )}
          </label>
        ))
      ) : (
        <p>No inputs required.</p>
      )}
      <h3>Models</h3>
      {definition.roles.map((role) => {
        const current = binding.roles[role] ?? {
          providerId: "",
          modelId: "",
          accessCeiling: "read-only" as const,
        };
        const review = definition.steps.some(
          (step) => step.kind === "review" && step.role === role,
        );
        const provider = setup.providers.find(
          (provider) => provider.id === current.providerId,
        );
        const set = (next: typeof current) =>
          change({ ...binding, roles: { ...binding.roles, [role]: next } });
        return (
          <fieldset key={role}>
            <legend>
              {role}
              {review ? " · reviewer" : ""}
            </legend>
            <label>
              Provider for {role}
              <select
                value={current.providerId}
                onChange={(event) =>
                  set({
                    ...current,
                    providerId: event.target.value,
                    modelId: "",
                  })
                }
              >
                <option value="">Choose a provider…</option>
                {setup.providers.map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={
                      !provider.enabled || (review && !provider.reviewAvailable)
                    }
                  >
                    {provider.label} · {provider.transport}
                    {!provider.enabled
                      ? " · disabled"
                      : review && !provider.reviewAvailable
                        ? " · no-tool review unavailable"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
            {provider ? (
              <label>
                Model for {role}
                <input
                  value={current.modelId}
                  list={`${id}-${role}`}
                  onChange={(event) =>
                    set({ ...current, modelId: event.target.value })
                  }
                />
                <datalist id={`${id}-${role}`}>
                  {provider?.modelIds.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </label>
            ) : null}
            {definition.steps.some(
              (step) => step.kind === "agent" && step.role === role,
            ) ? (
              <details>
                <summary>
                  Permissions ·{" "}
                  {current.accessCeiling === "read-only"
                    ? "Read only"
                    : "Workspace with approvals"}
                </summary>
                <label>
                  Allowed access
                  <select
                    value={current.accessCeiling}
                    onChange={(event) =>
                      set({
                        ...current,
                        accessCeiling: event.target.value as
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
              </details>
            ) : null}
          </fieldset>
        );
      })}
      {definition.steps.some((step) => step.kind === "verification") ? (
        <>
          <h3>Checks to run</h3>
          {[
            ...new Set(
              definition.steps.flatMap((step) =>
                step.kind === "verification" ? [step.commandRef] : [],
              ),
            ),
          ].map((ref) => {
            const command = binding.commands[ref];
            const task = setup.tasks.find(
              (task) =>
                task.id === command?.taskId &&
                task.command === command?.program &&
                task.fingerprint === command?.taskFingerprint &&
                JSON.stringify(task.args) === JSON.stringify(command.args),
            );
            return (
              <label key={ref}>
                {ref}
                <select
                  value={task?.id ?? ""}
                  onChange={(event) => {
                    const task = setup.tasks.find(
                      (task) => task.id === event.target.value,
                    );
                    if (task)
                      change({
                        ...binding,
                        commands: {
                          ...binding.commands,
                          [ref]: {
                            program: task.command,
                            args: task.args,
                            taskId: task.id,
                            taskFingerprint: task.fingerprint,
                          },
                        },
                      });
                  }}
                >
                  <option value="">Choose a discovered project task</option>
                  {setup.tasks.map((task) => (
                    <option value={task.id} key={task.id}>
                      {task.label}
                    </option>
                  ))}
                </select>
                {command ? (
                  <code>
                    {JSON.stringify([command.program, ...command.args])}
                  </code>
                ) : null}
              </label>
            );
          })}
        </>
      ) : null}
    </>
  );
}
