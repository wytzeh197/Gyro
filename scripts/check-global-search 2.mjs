import assert from "node:assert/strict";

import {
  createGlobalSearchTarget,
  globalSearchMatch,
  globalSearchMatchScore,
  GlobalSearchRanker,
} from "../packages/ui/src/global-search.ts";

const entry = (label, detail = "", keywords = "", priority = 0) => ({
  label,
  detail,
  priority,
  target: createGlobalSearchTarget(label, detail, keywords),
});

const corpus = [
  entry("New chat", "Start a desktop session", "thread conversation", 0),
  entry("Open settings", "Preferences", "", 1),
  entry("Set CLI launch preset", "Choose agents and pane counts", "", 2),
  entry(
    "global-search.ts",
    "packages/ui/src",
    "packages/ui/src/global-search.ts",
    3,
  ),
  entry(
    "surfaces.tsx",
    "packages/ui/src",
    "packages/ui/src/global-search.ts",
    4,
  ),
  entry("Café résumé", "notes", "", 5),
];

const scoreOf = (query, item) => globalSearchMatch(query, item.target).score;
const rankedLabels = (ranker, query, limit = 10) =>
  ranker.rank(query, limit).map((result) => result.item.label);

// A label prefix outranks the same word buried in another label.
assert.ok(
  scoreOf("set", corpus[2]) < scoreOf("set", corpus[1]),
  "prefix matches should outrank mid-label matches",
);

// Acronyms and dropped characters still find the file — the old substring
// scorer could not match "gsts" at all.
assert.ok(
  Number.isFinite(scoreOf("gsts", corpus[3])),
  "subsequence queries should match",
);
assert.ok(
  scoreOf("gsts", corpus[3]) < scoreOf("gsts", corpus[4]),
  "boundary hits should beat scattered ones",
);

// Every token has to appear somewhere in the target.
assert.equal(
  scoreOf("zzz", corpus[3]),
  Number.POSITIVE_INFINITY,
  "unmatched tokens should not produce a result",
);
assert.equal(
  scoreOf("global nowhere", corpus[3]),
  Number.POSITIVE_INFINITY,
  "every token must match",
);

// Multi-token queries match across the label and its detail line.
assert.ok(
  Number.isFinite(scoreOf("surfaces ui", corpus[4])),
  "tokens should match across label and detail",
);

// Fuzziness is a label privilege: a loose subsequence of a description or a
// path is noise, not a result.
assert.equal(
  scoreOf("cagp", corpus[2]),
  Number.POSITIVE_INFINITY,
  "loose subsequences of the detail line should not match",
);
assert.ok(
  Number.isFinite(scoreOf("packages/ui", corpus[3])),
  "substrings of the path should still match",
);

// Label matches beat detail matches for the same word.
assert.ok(
  scoreOf("preferences", corpus[1]) > scoreOf("settings", corpus[1]),
  "label matches should outrank detail matches",
);

// Folding is diacritic-insensitive and keeps highlight ranges aligned with the
// original text.
const cafe = globalSearchMatch("cafe", corpus[5].target);
assert.ok(Number.isFinite(cafe.score), "folded queries should match");
assert.deepEqual(
  cafe.labelRanges,
  [{ start: 0, end: 4 }],
  "highlight ranges should index the original label",
);
const chat = globalSearchMatch("chat", corpus[0].target);
assert.equal(
  corpus[0].label.slice(chat.labelRanges[0].start, chat.labelRanges[0].end),
  "chat",
  "highlight ranges should cover the matched text",
);

// Ranking is ordered, bounded, and unfiltered when the query is empty.
const ranker = new GlobalSearchRanker();
ranker.setCandidates(corpus);
assert.deepEqual(
  rankedLabels(ranker, "", 3),
  ["New chat", "Open settings", "Set CLI launch preset"],
  "an empty query should keep candidate order",
);
assert.equal(
  rankedLabels(ranker, "s", 2).length,
  2,
  "limits should be honoured",
);
assert.deepEqual(
  rankedLabels(ranker, "zzz"),
  [],
  "queries with no match should return nothing",
);

// Incremental narrowing has to agree with ranking from scratch, including after
// a backspace and after an unrelated jump.
const fresh = () => {
  const instance = new GlobalSearchRanker();
  instance.setCandidates(corpus);
  return instance;
};
for (const sequence of [
  ["s", "se", "set", "se", "s"],
  ["g", "gl", "glo", "glob", "glo", "café"],
  ["new", "new c", "new ch", "n"],
]) {
  const narrowing = fresh();
  for (const query of sequence) {
    assert.deepEqual(
      rankedLabels(narrowing, query),
      rankedLabels(fresh(), query),
      `narrowed results should match a cold rank for "${query}"`,
    );
  }
}

// Swapping the candidate list drops the narrowing cache.
const reused = fresh();
rankedLabels(reused, "se");
reused.setCandidates([entry("Second run", "replaced")]);
assert.deepEqual(
  rankedLabels(reused, "sec"),
  ["Second run"],
  "new candidates should invalidate cached survivors",
);

// The legacy scorer keeps working for callers that pass plain strings.
assert.equal(globalSearchMatchScore("", "New chat", "New chat"), 0);
assert.ok(
  Number.isFinite(globalSearchMatchScore("chat", "New chat", "New chat")),
);
assert.equal(
  globalSearchMatchScore("zzz", "New chat", "New chat"),
  Number.POSITIVE_INFINITY,
);

// A one-character query over a large corpus stays well inside a frame budget.
const manyFiles = Array.from({ length: 8_000 }, (_, index) =>
  entry(
    `module-${index}.ts`,
    `packages/ui/src/generated/${index}`,
    `packages/ui/src/generated/${index}/module-${index}.ts`,
    index,
  ),
);
const large = new GlobalSearchRanker();
large.setCandidates(manyFiles);
const started = performance.now();
for (const query of ["m", "mo", "mod", "modu", "modul", "module"]) {
  large.rank(query, 16);
}
const elapsed = performance.now() - started;
assert.ok(elapsed < 1_500, `ranking 8k files took ${elapsed.toFixed(0)}ms`);

console.log("global search checks passed");
