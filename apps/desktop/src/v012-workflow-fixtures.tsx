// Isolated production-component fixtures. No native/provider execution.
import React from "react";
import { createRoot } from "react-dom/client";
import { WorkflowDestination, applyAppearancePreferences } from "@gyro-dev/ui";
import type {
  WorkflowRuntime,
  WorkflowDefinition,
  WorkflowBinding,
  WorkflowRun,
  WorkflowDraft,
  WorkflowJob,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const params = new URLSearchParams(location.search);
const state = params.get("state");
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.density =
  params.get("density") === "compact" ? "compact" : "comfortable";
applyAppearancePreferences(
  document.documentElement,
  {
    interfaceSize: "default",
    mainColor: "#0874df",
    secondaryColor: "#8b6fcb",
    motionSpeed: "default",
  },
  theme,
);
const project = {
  sessionId: "source-fixture",
  rootId: "root-fixture",
  path: "/fixture/Gyro",
  title: "Project inspection",
};
let recipe: WorkflowDefinition = {
  schema: "gyro.workflow.v1",
  id: "inspect",
  name: "Inspect changes",
  description:
    "Inspect scoped changes, review them independently and run focused verification.",
  inputs: [{ id: "path", label: "File path", type: "path", required: true }],
  roles: ["reader", "reviewer"],
  steps: [
    {
      kind: "agent",
      id: "inspect",
      role: "reader",
      instructions: "Inspect {{input.path}}",
      requestedAccess: "read-only",
      output: { name: "report", required: true },
    },
    {
      kind: "review",
      id: "review",
      role: "reviewer",
      sourceStep: "inspect",
      instructions: "Review recorded changes",
    },
    {
      kind: "verification",
      id: "verify",
      commandRef: "focused-tests",
      instructions: "Run the bound focused tests",
    },
  ],
  completion: {
    requiredOutputs: ["report"],
    requireReviewCompletion: true,
    requireVerificationSuccess: true,
  },
};
const hash = "a1234567890bcdefa1234567890bcdef";
let saved: WorkflowBinding | undefined =
  state === "stale"
    ? {
        definitionId: recipe.id,
        definitionHash: "old-recipe-hash",
        roles: {
          reader: {
            providerId: "cli-fixture",
            modelId: "cli-model",
            accessCeiling: "read-only",
          },
        },
        commands: {},
        inputs: { path: "src/value.rs" },
      }
    : undefined;
let definitions =
  state === "empty"
    ? []
    : [
        { path: ".gyro/workflows/inspect.json", definition: recipe, hash },
        {
          path: ".gyro/workflows/future.json",
          diagnostic: "Unsupported gyro.workflow.v9; original file preserved",
        },
      ];
let jobs: WorkflowJob[] = [];
let drafts: WorkflowDraft[] = [];
const run: WorkflowRun = {
  id: "run-fixture",
  revision: 3,
  operationId: "run-operation",
  sourceSessionId: "container",
  rootId: project.rootId,
  rootKey: project.path,
  origin: "automation",
  definition: recipe,
  binding: {
    definitionId: recipe.id,
    definitionHash: hash,
    roles: {
      reader: {
        providerId: "cli-fixture",
        modelId: "cli-model",
        accessCeiling: "read-only",
      },
      reviewer: {
        providerId: "api-fixture",
        modelId: "review-model",
        accessCeiling: "read-only",
      },
    },
    commands: {
      "focused-tests": {
        program: "pnpm",
        args: ["test", "--", "src/value.test.ts"],
      },
    },
    inputs: { path: "src/value.rs" },
  },
  status:
    state === "waiting"
      ? "waiting"
      : state === "interrupted"
        ? "interrupted"
        : state === "running"
          ? "running"
          : "completed",
  requirementsMet: state === "attention" ? false : undefined,
  createdAt: "2026-11-10T12:00:00Z",
  error:
    state === "waiting"
      ? "Approval attempt stopped. Inspect recorded actions before retrying."
      : undefined,
  steps: [
    {
      stepId: "inspect",
      status: "completed",
      sessionId: "agent-fixture",
      turnId: "turn-fixture",
      output: "Captured inspection output.",
      openFindings: 0,
    },
    {
      stepId: "review",
      status:
        state === "waiting" || state === "interrupted"
          ? "interrupted"
          : "completed",
      sessionId: "review-fixture",
      reviewId: "review-fixture",
      reviewCompleted:
        state === "waiting" || state === "interrupted"
          ? undefined
          : state !== "attention",
      openFindings: state === "attention" ? 2 : 0,
    },
    {
      stepId: "verify",
      status:
        state === "running"
          ? "running"
          : state === "waiting" || state === "interrupted"
            ? "pending"
            : "completed",
      verificationPassed: state === "attention" ? false : undefined,
      openFindings: 0,
    },
  ],
};
let runs: WorkflowRun[] = [
  "waiting",
  "interrupted",
  "running",
  "attention",
].includes(state ?? "")
  ? [run]
  : [];
const callbacks = new Set<() => void>();
const emit = () => callbacks.forEach((callback) => callback());
const calls: {
  domain: string;
  action: string;
  session?: string;
  payload?: unknown;
}[] = [];
Object.assign(window, { workflowFixture: { calls, opened: [] as string[] } });
const providers = [
  {
    id: "cli-fixture",
    label: "CLI fixture",
    transport: "CLI",
    enabled: true,
    reviewAvailable: false,
    modelIds: ["cli-model"],
  },
  {
    id: "api-fixture",
    label: "Review API",
    transport: "API",
    enabled: true,
    reviewAvailable: true,
    modelIds: ["review-model"],
  },
  {
    id: "disabled",
    label: "Disabled provider",
    transport: "API",
    enabled: false,
    reviewAvailable: true,
    modelIds: ["unavailable"],
  },
];
async function request(
  domain: string,
  action: string,
  payload: any = {},
  session?: string,
): Promise<any> {
  calls.push({ domain, action, session, payload });
  if (state === "error" && action === "projects")
    throw Error("Fixture: source project unavailable");
  if (domain === "definition") {
    if (action === "list")
      return {
        rootId: project.rootId,
        roots: [{ id: project.rootId, path: project.path }],
        definitions,
      };
    if (action === "read")
      return { definition: recipe, expectedHash: "raw-base" };
    if (action === "save") {
      if (state === "conflict")
        throw Error("Workflow changed on disk; reload before saving");
      recipe = payload.definition;
      definitions = [
        { path: `.gyro/workflows/${recipe.id}.json`, definition: recipe, hash },
      ];
      emit();
      return { saved: true };
    }
  }
  if (domain === "run") {
    if (action === "projects") return [project];
    if (action === "project") return project;
    if (action === "jobs") return jobs;
    if (action === "runs")
      return runs.map(({ binding, definition, steps, ...run }) => ({
        ...run,
        definition: {
          id: definition.id,
          name: definition.name,
          description: definition.description,
        },
        steps: steps.map(({ output, ...step }) => step),
      }));
    if (action === "get") return runs.find((run) => run.id === payload.runId);
    if (action === "setup")
      return {
        rootId: project.rootId,
        roots: [{ id: project.rootId, path: project.path }],
        providers,
        tasks: [
          {
            id: "focused-test",
            fingerprint: "task-witness",
            label: "Focused tests",
            command: "pnpm",
            args: ["test", "--", "src/value.test.ts"],
          },
        ],
      };
    if (action === "binding")
      return {
        revision: saved ? 1 : 0,
        binding: saved,
        stale: saved?.definitionHash !== hash,
      };
    if (action === "save-binding") {
      saved = payload.binding;
      return { revision: 2 };
    }
    if (action === "preflight") {
      if (
        !payload.binding.inputs.path ||
        Object.keys(payload.binding.roles).length !== 2 ||
        !payload.binding.commands["focused-tests"]
      )
        throw Error(
          "Choose every required input, role model and verification command",
        );
      return { ready: true, queuedAfterCurrentChat: state === "busy" };
    }
    if (action === "launch" || action === "schedule" || action === "retry") {
      jobs = [
        {
          id: "queued-job",
          title: recipe.name,
          schedule: action === "schedule" ? payload.schedule : "manual",
          status: "current",
          updatedAt: "2026-11-10T12:00:00Z",
          lastResult: "",
          runHistory: [],
          execution: {
            workspacePath: project.path,
            workflowBinding: {
              sourceSessionId: project.sessionId,
              rootId: project.rootId,
              definition: recipe,
              binding: payload.binding ?? run.binding,
            },
          },
        },
      ];
      emit();
      return jobs[0];
    }
    if (action === "toggle-job") {
      jobs = jobs.map((job) => ({
        ...job,
        status: payload.paused ? "paused" : "current",
      }));
      emit();
      return jobs[0];
    }
    if (action === "delete") {
      runs = runs.filter((run) => run.id !== payload.runId);
      emit();
      return { deleted: true };
    }
    if (action === "stop") {
      runs = runs.map((run) => ({
        ...run,
        status: "cancelled",
        revision: run.revision + 1,
      }));
      emit();
      return runs[0];
    }
    if (action === "retry-preview")
      return {
        revision: run.revision,
        workspaceFingerprint: "fixture-witness",
        stepId: "review",
        completedSteps: 1,
        message:
          "Inspect recorded actions. An unfinished step may repeat side effects; completed steps remain preserved.",
      };
  }
  if (domain === "extraction") {
    if (action === "list") return drafts;
    if (action === "turns")
      return [
        {
          turnId: "turn-fixture",
          eventId: "event-fixture",
          request: "Inspect the scoped arithmetic change",
          status: state === "unproven" ? "error" : "done",
          hasAnswer: true,
        },
      ];
    if (action === "capture") {
      drafts = [
        {
          id: "draft-fixture",
          revision: 1,
          sourceSessionId: project.sessionId,
          rootId: project.rootId,
          sourceTurnIds: ["turn-fixture"],
          sourceComplete: state !== "unproven",
          captureHash: "frozen-source-123456",
          capturedBytes: 382,
          status: "preview",
          createdAt: "2026-11-10T12:00:00Z",
        },
      ];
      return drafts[0];
    }
    if (action === "get") return drafts[0];
    if (action === "input")
      return {
        input: "Frozen source evidence. No tools or hidden provider choices.",
      };
    if (action === "output") return { output: JSON.stringify(recipe, null, 2) };
    if (action === "start") {
      drafts = drafts.map((draft) => ({
        ...draft,
        status: state === "extract-running" ? "running" : "ready",
        revision: 2,
        definition: recipe,
      }));
      emit();
      return drafts[0];
    }
    if (action === "delete") {
      runs = runs.filter((run) => run.id !== payload.runId);
      emit();
      return { deleted: true };
    }
    if (action === "stop") {
      drafts = drafts.map((draft) => ({
        ...draft,
        status: "cancelled",
        revision: 3,
      }));
      emit();
      return drafts[0];
    }
    if (action === "delete") {
      drafts = [];
      emit();
      return { deleted: true };
    }
  }
  throw Error(`Unhandled fixture action ${domain}:${action}`);
}
const runtime: WorkflowRuntime = {
  key: "workflow-fixture",
  definition: (action, session, root, payload) =>
    request("definition", action, payload, session),
  run: (action, payload, session) => request("run", action, payload, session),
  extraction: (action, payload, session) =>
    request("extraction", action, payload, session),
  subscribe: (callback) => {
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  },
};
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    <main style={{ height: "100vh", overflow: "hidden" }}>
      <WorkflowDestination
        runtime={runtime}
        initialSessionId={project.sessionId}
        onOpenSession={(id) => (window as any).workflowFixture.opened.push(id)}
      >
        <section aria-label="Legacy schedules">
          <h2>Existing prompt schedules</h2>
          <p>Legacy scheduled prompts stay available.</p>
          <button>New prompt schedule</button>
        </section>
      </WorkflowDestination>
    </main>,
  );
