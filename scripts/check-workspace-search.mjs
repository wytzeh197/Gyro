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

const {
  replaceWorkspaceSearchMatches,
  workspaceSearchMatcher,
  workspaceSearchRequestFlags,
} = await import("../packages/ui/src/workspace-search.ts");

assert.deepEqual(
  workspaceSearchRequestFlags({ query: "x" }),
  { caseSensitive: false, wholeWord: false, regex: false },
  "UI search defaults to case-insensitive literal matching",
);
assert.equal(
  replaceWorkspaceSearchMatches("Needle needle needles", { query: "needle" }, "pin")
    ?.content,
  "pin pin pins",
  "Default replace ignores case",
);
assert.equal(
  replaceWorkspaceSearchMatches(
    "Needle needle needles",
    { query: "needle", matchCase: true, wholeWord: true },
    "pin",
  )?.content,
  "Needle pin needles",
  "Match case and whole word narrow the replace",
);
assert.equal(
  replaceWorkspaceSearchMatches("a.b axb", { query: "a.b" }, "$1")?.content,
  "$1 axb",
  "Literal replace escapes the query and keeps $ text as typed",
);
assert.deepEqual(
  replaceWorkspaceSearchMatches(
    "foo(1) foo(22)",
    { query: "foo\\((\\d+)\\)", useRegex: true, matchCase: true },
    "bar[$1]",
  ),
  { content: "bar[1] bar[22]", occurrences: 2 },
  "Regex replace expands capture groups",
);
assert.equal(
  workspaceSearchMatcher({ query: "(", useRegex: true }),
  undefined,
  "Invalid regex yields no matcher",
);
assert.equal(
  replaceWorkspaceSearchMatches("nothing", { query: "zzz" }, "y")?.occurrences,
  0,
);
