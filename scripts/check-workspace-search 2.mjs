import assert from "node:assert/strict";
import { workspaceSearchPreview } from "../packages/ui/src/workspace-search-preview.ts";

const marked = (preview) =>
  preview.parts.filter((part) => part.matched).map((part) => part.text);
assert.deepEqual(
  marked(
    workspaceSearchPreview("é 🦀 needle needles", "need\\w+", [
      { startColumn: 6, endColumn: 12 },
      { startColumn: 13, endColumn: 20 },
    ]),
  ),
  ["needle", "needles"],
  "Backend ranges must win over the query text",
);
assert.deepEqual(
  marked(
    workspaceSearchPreview("    hit hit", "hit", [
      { startColumn: 5, endColumn: 8 },
      { startColumn: 9, endColumn: 12 },
    ]),
  ),
  ["hit", "hit"],
  "Removing indentation must preserve match positions",
);
assert.deepEqual(marked(workspaceSearchPreview("a+b a+b", "a+b")), [
  "a+b",
  "a+b",
]);
assert.deepEqual(marked(workspaceSearchPreview("text", "")), []);
assert.deepEqual(marked(workspaceSearchPreview("hit", "hit", [])), []);
assert.deepEqual(
  marked(
    workspaceSearchPreview("hit", "hit", [{ startColumn: 0, endColumn: 100 }]),
  ),
  [],
);
const long = workspaceSearchPreview(
  `${"x".repeat(300)}hit${"y".repeat(300)}`,
  "hit",
  [{ startColumn: 301, endColumn: 304 }],
);
assert.equal(long.leadingEllipsis, true);
assert.equal(long.trailingEllipsis, true);
assert.deepEqual(marked(long), ["hit"]);
assert.ok(long.parts.map((part) => part.text).join("").length <= 240);
console.log("workspace search checks passed");
