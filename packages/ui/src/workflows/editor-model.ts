import type { WorkflowDefinition, WorkflowStep } from "./types";
export function uniqueName(prefix: string, used: string[]) {
  let index = 1;
  while (used.includes(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
export const newAgent = (
  index: number,
): Extract<WorkflowStep, { kind: "agent" }> => ({
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
    instructions:
      "Review the current changes in this project. Identify concrete bugs, regressions, and missing tests. Explain each finding with file references and suggest a focused fix. Do not modify files.",
  },
  {
    name: "Investigate a bug",
    description: "Trace a problem and propose a fix.",
    instructions:
      "Investigate the reported problem: {{input.problem}}. Trace the relevant code, identify the likely cause with evidence, and propose a minimal fix and a way to verify it. Do not modify files.",
  },
  {
    name: "Draft documentation",
    description: "Turn existing code into a clear guide.",
    instructions:
      "Read the project and draft a concise guide to its purpose, setup, and main workflows. Verify commands against the actual project files and flag anything that could not be confirmed. Return the draft without modifying files.",
  },
  {
    name: "Fix and verify a bug",
    description: "Reproduce, fix, verify, and independently review a bug.",
    instructions:
      "Fix the reported problem: {{input.requirements}}. Reproduce it first, record the failing behavior, make a focused fix, and verify the original reproduction. Preserve unrelated work. Return changed files, requirements, evidence, and unresolved limitations. Do not commit or publish.",
  },
  {
    name: "Fix a browser issue",
    description: "Fix a visual issue and check the same browser target.",
    instructions:
      "Fix this browser issue: {{input.requirements}}. Use the supplied URL and annotation when available. Capture the original target and viewport, make a focused fix, then reacquire the same target and verify behavior and appearance. Keep browser checks hidden. If the target is missing or ambiguous, report the limitation rather than substituting a different element. Return before/after evidence and checks. Do not commit or publish.",
  },
  {
    name: "Build and verify a feature",
    description: "Implement acceptance requirements with tests and review.",
    instructions:
      "Implement this feature: {{input.requirements}}. Establish observable acceptance criteria, inspect project conventions, implement a focused change, and verify each criterion. Return changed files, evidence, and unverified requirements. Preserve unrelated work. Do not commit or publish.",
  },
] as const;

export function starterWorkflow(index: number): WorkflowDefinition {
  const starter = workflowStarters[index] ?? workflowStarters[0];
  const definition = emptyWorkflow();
  if (index >= 3 && index < workflowStarters.length) {
    return {
      ...definition,
      id: starter.name.toLowerCase().replaceAll(" ", "-"),
      name: starter.name,
      description: starter.description,
      inputs: [
        {
          id: "requirements",
          label: "Requirements and acceptance criteria",
          type: "string",
          required: true,
        },
      ],
      roles: ["implementer", "reviewer"],
      steps: [
        {
          ...newAgent(1),
          instructions: starter.instructions,
          requestedAccess: "workspace",
        },
        {
          id: "verify",
          kind: "verification",
          commandRef: "verify",
          instructions:
            "Run the project verification task selected during setup. A passing command only covers what that command actually checks.",
        },
        {
          id: "review",
          kind: "review",
          role: "reviewer",
          sourceStep: "step-1",
          instructions:
            "Independently review the implementation against the requirements and available verification evidence. Report concrete defects and missing coverage. Do not treat the agent's completion statement as proof.",
        },
      ],
      completion: {
        requiredOutputs: ["output-1"],
        requireReviewCompletion: true,
        requireVerificationSuccess: true,
      },
    };
  }
  return {
    ...definition,
    id: starter.name.toLowerCase().replaceAll(" ", "-"),
    name: starter.name,
    description: starter.description,
    inputs:
      index === 1
        ? [
            {
              id: "problem",
              label: "What problem should Gyro investigate?",
              type: "string",
              required: true,
            },
          ]
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
