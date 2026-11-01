import assert from "node:assert/strict";
import { parseAssistantResponseHeading } from "../packages/ui/src/assistant-response-heading.ts";

for (let level = 1; level <= 6; level += 1) {
  assert.deepEqual(
    parseAssistantResponseHeading(`${"#".repeat(level)} Section`),
    {
      kind: "heading",
      level,
      content: "Section",
    },
  );
}
assert.deepEqual(parseAssistantResponseHeading("  ## Retry **limits**  ##  "), {
  kind: "heading",
  level: 2,
  content: "Retry **limits**",
});
assert.equal(parseAssistantResponseHeading("### C#")?.content, "C#");
for (const prose of [
  "#123 issue",
  "Use # headings",
  "####### Too deep",
  "```ts",
  "",
]) {
  assert.equal(parseAssistantResponseHeading(prose), undefined);
}
console.log(
  "Assistant heading checks passed: hierarchy, inline content, closing marks, and prose.",
);
