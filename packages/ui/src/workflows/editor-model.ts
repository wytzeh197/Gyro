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
