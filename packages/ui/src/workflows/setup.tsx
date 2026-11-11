import { WorkflowBindingFields } from "./binding-fields";
import { useEffect, useRef, useState } from "react";
import type {
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowJob,
  WorkflowProject,
  WorkflowRuntime,
  WorkflowSetup,
} from "./types";
export function WorkflowSetupPanel({
  runtime,
  project,
  definition,
  hash,
  job,
  onClose,
  onLaunched,
}: {
  runtime: WorkflowRuntime;
  project: WorkflowProject;
  definition: WorkflowDefinition;
  hash: string;
  job?: WorkflowJob;
  onClose: () => void;
  onLaunched: (destination: "run" | "schedule") => void;
}) {
  const booleans = Object.fromEntries(
    definition.inputs
      .filter((input) => input.type === "boolean")
      .map((input) => [input.id, false]),
  );
  const [setup, setSetup] = useState<WorkflowSetup>();
  const [binding, setBinding] = useState<WorkflowBinding>({
    definitionId: definition.id,
    definitionHash: hash,
    roles: {},
    commands: {},
    inputs: booleans,
  });
  const [revision, setRevision] = useState(0);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState("manual");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [checked, setChecked] = useState(false);
  const primaryAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (checked) primaryAction.current?.focus();
  }, [checked]);
  const operation = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const expectedJobVersion = useRef(job?.updatedAt);
  const scheduleChanged = job?.updatedAt !== expectedJobVersion.current;
  useEffect(() => {
    const sequence = ++generation.current;
    void Promise.all([
      runtime.run<WorkflowSetup>(
        "setup",
        {},
        project.sessionId,
        project.rootId,
      ),
      runtime.run<{
        revision: number;
        binding?: WorkflowBinding;
        stale: boolean;
      }>(
        "binding",
        { definitionId: definition.id },
        project.sessionId,
        project.rootId,
      ),
    ])
      .then(([setup, saved]) => {
        if (sequence !== generation.current) return;
        setSetup(setup);
        setRevision(saved.revision);
        const existing =
          job?.execution.workflowBinding.binding ?? saved.binding;
        if (existing) {
          setBinding({
            ...existing,
            inputs: { ...booleans, ...existing.inputs },
          });
          setStale(existing.definitionHash !== hash);
        }
      })
      .catch((error) => {
        if (sequence === generation.current) setError(String(error));
      });
    return () => {
      generation.current++;
    };
  }, [
    runtime,
    project.sessionId,
    project.rootId,
    definition.id,
    hash,
    job?.id,
  ]);
  function change(next: WorkflowBinding) {
    setBinding(next);
    setChecked(false);
    setNotice("");
    operation.current = crypto.randomUUID();
  }
  async function act(
    action: "preflight" | "save-binding" | "launch" | "schedule" | "adopt",
  ) {
    const sequence = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await runtime.run<{
        revision?: number;
        queuedAfterCurrentChat?: boolean;
      }>(
        action,
        {
          definitionId: definition.id,
          binding,
          revision,
          operationId: operation.current,
          schedule,
          calendar: schedule === "daily-at" ? { timezone, time } : undefined,
          jobId: job?.id,
          updatedAt: expectedJobVersion.current,
        },
        project.sessionId,
        project.rootId,
      );
      if (sequence !== generation.current) return;
      if (action === "preflight") {
        setChecked(true);
        setNotice(
          result.queuedAfterCurrentChat
            ? "Configuration checked. The launch will wait for the current chat to finish."
            : "Configuration checked. Current approvals still apply.",
        );
      } else if (action === "save-binding") {
        setRevision(result.revision ?? revision);
        setNotice("Setup saved. No run was started.");
      } else {
        onLaunched(action === "launch" ? "run" : "schedule");
      }
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    } finally {
      if (sequence === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Workflow setup">
      <h2>Run {definition.name}</h2>
      <p>{project.path}</p>
      <p>
        Choose who runs each step. Your usual approvals and provider billing
        apply.
      </p>
      <details>
        <summary>Run details</summary>
        <p>
          Local checkout · version {hash.slice(0, 12)}. Each run has a 30 minute
          deadline. Interrupted actions need an explicit retry. API roles use
          your configured credentials; CLI roles use their existing sign-in.
        </p>
      </details>
      {!setup ? (
        <p role="status">Loading setup…</p>
      ) : (
        <fieldset disabled={busy}>
          {stale ? (
            <div role="alert">
              <p>
                The recipe changed since this setup was saved. Inspect the
                current recipe before adopting this version.
              </p>
              <details>
                <summary>Current recipe</summary>
                <pre>{JSON.stringify(definition, null, 2)}</pre>
              </details>
              <button
                onClick={() => {
                  change({
                    ...binding,
                    definitionHash: hash,
                    definitionId: definition.id,
                    roles: Object.fromEntries(
                      definition.roles
                        .filter((role) => binding.roles[role])
                        .map((role) => [role, binding.roles[role]!]),
                    ),
                    inputs: Object.fromEntries(
                      Object.entries(binding.inputs).filter(([id]) =>
                        definition.inputs.some((input) => input.id === id),
                      ),
                    ),
                    commands: Object.fromEntries(
                      Object.entries(binding.commands).filter(([id]) =>
                        definition.steps.some(
                          (step) =>
                            step.kind === "verification" &&
                            step.commandRef === id,
                        ),
                      ),
                    ),
                  });
                  setStale(false);
                }}
              >
                Adopt this recipe version
              </button>
            </div>
          ) : null}
          <WorkflowBindingFields
            definition={definition}
            binding={binding}
            setup={setup}
            change={change}
          />
          {!job ? (
            <details>
              <summary>Schedule (optional)</summary>
              <>
                <label>
                  Run timing
                  <select
                    value={schedule}
                    onChange={(event) => {
                      setSchedule(event.target.value);
                      setChecked(false);
                      operation.current = crypto.randomUUID();
                    }}
                  >
                    <option value="manual">Run once now</option>
                    <option value="hourly">Hourly</option>
                    <option value="daily-at">Daily at a local time</option>
                  </select>
                </label>
                {schedule === "daily-at" ? (
                  <>
                    <label>
                      Local time
                      <input
                        type="time"
                        value={time}
                        onChange={(event) => {
                          setTime(event.target.value);
                          operation.current = crypto.randomUUID();
                          setChecked(false);
                        }}
                      />
                    </label>
                    <label>
                      Timezone
                      <input
                        value={timezone}
                        onChange={(event) => {
                          setTimezone(event.target.value);
                          operation.current = crypto.randomUUID();
                          setChecked(false);
                        }}
                      />
                    </label>
                  </>
                ) : null}
              </>
            </details>
          ) : null}
          <p>
            {schedule === "manual" && !job
              ? "Runs once when you start it."
              : job
                ? "Updates this saved schedule."
                : `Repeats ${schedule === "hourly" ? "every hour" : `daily at ${time} (${timezone})`}.`}
          </p>
        </fieldset>
      )}
      {scheduleChanged ? (
        <p role="alert">
          This schedule changed elsewhere. Close and reopen setup to review the
          current version.
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="gyro-workflow-actions">
        {!checked ? (
          <button
            className="gyro-primary-button"
            disabled={!setup || busy || stale}
            onClick={() => void act("preflight")}
          >
            {busy ? "Checking…" : "Check setup"}
          </button>
        ) : null}
        <button
          disabled={!setup || busy || stale}
          onClick={() => void act("save-binding")}
        >
          Save setup
        </button>
        {checked ? (
          <button
            ref={primaryAction}
            className="gyro-primary-button"
            disabled={!checked || busy || stale || scheduleChanged}
            onClick={() =>
              void act(
                job ? "adopt" : schedule === "manual" ? "launch" : "schedule",
              )
            }
          >
            {busy
              ? "Working…"
              : job
                ? "Update schedule setup"
                : schedule === "manual"
                  ? "Start workflow"
                  : "Create schedule"}
          </button>
        ) : null}
        <button disabled={busy} onClick={onClose}>
          Back
        </button>
      </div>
    </section>
  );
}
