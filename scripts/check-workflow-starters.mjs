import assert from "node:assert/strict";
import {
  starterWorkflow,
  workflowStarters,
} from "../packages/ui/src/workflows/editor-model.ts";

for (let index = 0; index < workflowStarters.length; index++) {
  const workflow = starterWorkflow(index);
  const inputs = new Set(workflow.inputs.map((input) => input.id));
  const priorAgents = new Set();
  const outputs = new Set();
  for (const step of workflow.steps) {
    for (const match of step.instructions.matchAll(/\{\{input\.([^}]+)\}\}/g))
      assert.ok(inputs.has(match[1]), `Undeclared input in ${workflow.name}`);
    if (step.kind === "agent") {
      priorAgents.add(step.id);
      outputs.add(step.output.name);
    } else if (step.kind === "review") {
      assert.ok(
        priorAgents.has(step.sourceStep),
        "review has a preceding agent",
      );
    }
  }
  assert.ok(
    workflow.completion.requiredOutputs.every((output) => outputs.has(output)),
  );
  if (index >= 3) {
    assert.equal(workflow.completion.requireReviewCompletion, true);
    assert.equal(workflow.completion.requireVerificationSuccess, true);
    assert.equal(workflow.steps[0].requestedAccess, "workspace");
    assert.ok(
      workflow.steps.some(
        (step) => step.kind === "verification" && step.commandRef === "verify",
      ),
    );
    assert.equal(
      "binding" in workflow,
      false,
      "recipes never inherit authority",
    );
  } else assert.equal(workflow.steps[0].requestedAccess, "read-only");
}
console.log(
  `${workflowStarters.length} workflow starters passed dependency, input, completion and authority checks.`,
);
