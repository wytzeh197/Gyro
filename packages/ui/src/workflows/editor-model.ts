import type { WorkflowDefinition, WorkflowStep } from "./types";
export function uniqueName(prefix: string, used: string[]) {
  let index = 1;
  while (used.includes(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
export const newAgent = (index: number): WorkflowStep => ({
  id: `step-${index}`,
  kind: "agent",
  role: "implementer",
  instructions: "",
  requestedAccess: "read-only",
  output: { name: `output-${index}`, required: true },
});
export const workflowStarters = [
  {
    name: "Review code",
    description: "Find bugs and risks in your changes.",
    instructions: "Review the current changes in this project. Identify concrete bugs, regressions, and missing tests. Explain each finding with file references and suggest a focused fix. Do not modify files.",
  },
  {
    name: "Investigate a bug",
    description: "Trace a problem and propose a fix.",
    instructions: "Investigate the reported problem: {{input.problem}}. Trace the relevant code, identify the likely cause with evidence, and propose a minimal fix and a way to verify it. Do not modify files.",
  },
  {
    name: "Draft documentation",
    description: "Turn existing code into a clear guide.",
    instructions: "Read the project and draft a concise guide to its purpose, setup, and main workflows. Verify commands against the actual project files and flag anything that could not be confirmed. Return the draft without modifying files.",
  },
] as const;

export function starterWorkflow(index: number): WorkflowDefinition {
  const starter = workflowStarters[index] ?? workflowStarters[0];
  const definition = emptyWorkflow();
  return {
    ...definition,
    id: starter.name.toLowerCase().replaceAll(" ", "-"),
    name: starter.name,
    description: starter.description,
    inputs: index === 1
      ? [{ id: "problem", label: "What problem should Gyro investigate?", type: "string", required: true }]
      : [],
    steps: [{ ...newAgent(1), instructions: starter.instructions }],
  };
}

export const emptyWorkflow = (): WorkflowDefinition => ({
  schema: "gyro.workflow.v1",
  id: "",
  name: "",
  description: "",
  inputs: [],
  roles: ["implementer"],
  steps: [newAgent(1)],
  completion: {
    requiredOutputs: ["output-1"],
    requireReviewCompletion: false,
    requireVerificationSuccess: false,
  },
});
