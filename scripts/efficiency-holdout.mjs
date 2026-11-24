// The source slices come from fixed Gyro commits, never from the dirty checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshot } from "./efficiency-repo-pilot.mjs";

const desktop = "apps/desktop/src/";
const ui = "packages/ui/src/";
const terminal = desktop + "terminal-output.ts";
const remote = desktop + "remote-access/terminal-stream.ts";
const retry = desktop + "chat-auto-retry.ts";
const history = desktop + "session-event-order.ts";
const usage = ui + "turn-tokens.ts";
const source = (revision, path) =>
  execFileSync("git", ["show", revision + ":" + path], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });

const cases = [
  {
    id: "terminal-output-append",
    commit: "da87473e06db99f0e6bdec1a5f53a0670022cb0f",
    file: terminal,
    prompt:
      "Deliver the new UTF-8 terminal suffix without re-encoding the full retained window on each append. Preserve process restart resets and the exact emoji.",
    diagnosis:
      "Append an emoji to a 10000-character ASCII terminal window using terminalOutputUpdate with contiguous byte positions in one process. Can the implementation deliver only that emoji while encoding fewer than 1024 UTF-16 code units?",
    probe:
      '(() => { const prefix = "a".repeat(10000); const encode = TextEncoder.prototype.encode; let size = 0; TextEncoder.prototype.encode = function(value) { size += value.length; return encode.call(this,value); }; try { const delta = api.terminalOutputUpdate(prefix,prefix+"😀",{start:0,end:10000,generation:"p"},{start:0,end:10004,generation:"p"}); return delta.data === "😀" && !delta.reset && size < 1024; } finally { TextEncoder.prototype.encode = encode; } })()',
    preserve:
      'api.terminalOutputUpdate("a","a",{start:0,end:1,generation:"old"},{start:0,end:1,generation:"new"}).reset',
    before: false,
    after: true,
  },
  {
    id: "remote-terminal-retained-bom",
    commit: "da87473e06db99f0e6bdec1a5f53a0670022cb0f",
    file: remote,
    dependencies: [terminal],
    prompt:
      "Preserve a leading BOM in the retained remote terminal window after trimming its byte budget. Keep its exact cursor accounting and make use of the shared terminal output merger.",
    diagnosis:
      "At the 512 KiB output limit, use an initial window containing ASCII x, then U+FEFF, then 524284 ASCII a characters. Append one ASCII b with a contiguous cursor. Does the merged output begin with the BOM?",
    probe:
      'api.mergeTerminalUpdate({id:"p",output:"x\\ufeff"+"a".repeat(524284),outputCursor:{start:0,end:524288,generation:"p"}},{id:"p",output:"b",outputCursor:{start:524288,end:524289,generation:"p"}}).output.startsWith("\\ufeff")',
    before: false,
    after: true,
  },
  {
    id: "retry-backend-owned",
    commit: "5ae59d78007d9d513cd25851cd5854e71b6f356b",
    file: retry,
    prompt:
      "Prevent UI auto-retry when the native backend owns recovery. A transient failure before work starts should stay eligible when recovery is not backend-owned.",
    diagnosis:
      "For a fresh user turn t, a system-event provider-status on turn t fails with HTTP 503, recovery kind server, and recoveryOwner backend. Is an automatic UI retry eligible?",
    probe:
      'Boolean(api.eligibleChatAutoRetryFailure(retryEvents({recoveryOwner:"backend"})))',
    preserve: "Boolean(api.eligibleChatAutoRetryFailure(retryEvents({})))",
    before: true,
    after: false,
    critical: true,
  },
  {
    id: "retry-exhausted-quota",
    commit: "5ae59d78007d9d513cd25851cd5854e71b6f356b",
    file: retry,
    prompt:
      "Treat the explicit quota-exceeded recovery kind as permanent even when the accompanying error looks like HTTP 503. Preserve retries for ordinary transient failures.",
    diagnosis:
      "For a fresh user turn t, a system-event provider-status on turn t fails with HTTP 503 and recoveryKind quota-exceeded. Is an automatic UI retry eligible?",
    probe:
      'Boolean(api.eligibleChatAutoRetryFailure(retryEvents({recoveryKind:"quota-exceeded"})))',
    preserve: "Boolean(api.eligibleChatAutoRetryFailure(retryEvents({})))",
    before: true,
    after: false,
    critical: true,
  },
  {
    id: "unchanged-transcript-page",
    commit: "a2fbbd116f649db480f38073687f57013cc956d4",
    file: history,
    prompt:
      "Return the existing transcript array when an otherwise identical incoming event has a different JSON key order. Compare values without stringifying complete payloads. Preserve ordering and real edits.",
    diagnosis:
      "Merge an otherwise identical transcript event with its top-level JSON keys in reverse order. Does the result use the same array object?",
    probe:
      "api.mergeSessionHistoryPages(rows, [Object.fromEntries(Object.entries(rows[0]).reverse())]) === rows",
    preserve:
      'api.mergeSessionHistoryPages(rows, [{...rows[0],message:"new"}])[0].message === "new"',
    before: false,
    after: true,
  },
  {
    id: "usage-turn-provenance",
    commit: "dbc6d3290b2ac5aab31f254c95a0c06762cc88cb",
    file: usage,
    dependencies: [ui + "token-count.ts"],
    prompt:
      "Expose showTurnTokenCount(events, providers) so token counts depend on the provider that ran the historical turn. Show API-key turns, including recorded direct API runners whose provider has been removed. Hide subscription and unknown turns.",
    diagnosis:
      "For a historical provider-response from a removed connection marked openai-compatible-api, does the module expose a showTurnTokenCount policy that returns true?",
    probe:
      'typeof api.showTurnTokenCount === "function" && api.showTurnTokenCount([{payload:{kind:"provider-response",runner:"openai-compatible-api",providerId:"removed"}}],[])',
    preserve:
      'typeof api.showTurnTokenCount !== "function" || api.showTurnTokenCount([{payload:{kind:"provider-response",providerId:"subscription"}}],[{id:"subscription",authMode:"subscription"}]) === false',
    before: false,
    after: true,
    critical: true,
  },
];

const controls = [
  "const retryEvents = (fields) => [{kind:'user-message',turnId:'t',message:'Fix it'},",
  "{kind:'system-event',turnId:'t',message:'HTTP 503',payload:{kind:'provider-status',status:'failed',error:'HTTP 503',recoveryKind:'server',...fields}}];",
  "const rows = [{id:'e1',kind:'assistant-message',message:'old',createdAt:'2026-10-01T00:00:00Z',payload:{}}];",
].join("\n");
const verifierImports = [
  'import assert from "node:assert/strict";',
  'import { test } from "node:test";',
  'import { join } from "node:path";',
  'import { pathToFileURL } from "node:url";',
  "const load = path => import(pathToFileURL(join(process.env.GYRO_VERIFY_WORKSPACE, path)));",
  controls,
].join("\n");
const behavior = (item, expected) =>
  "test(" +
  JSON.stringify(item.id) +
  ", async () => { const api = await load(" +
  JSON.stringify(item.file) +
  "); assert.equal(" +
  item.probe +
  ", " +
  expected +
  "); " +
  (item.preserve ? "assert.equal(" + item.preserve + ", true);" : "") +
  " });";
const answer = (expected) =>
  "test('diagnostic response', () => { const raw = (process.env.GYRO_VERIFY_FINAL_RESPONSE ?? '').trim().replace(/^" +
  String.fromCharCode(96).repeat(3) +
  "(?:json)?\\s*|\\s*" +
  String.fromCharCode(96).repeat(3) +
  "$/g, ''); assert.deepEqual(JSON.parse(raw), " +
  JSON.stringify(expected) +
  "); });";

const revisions = new Map();
const read = (revision, path) => {
  const key = revision + ":" + path;
  if (!revisions.has(key)) revisions.set(key, source(revision, path));
  return revisions.get(key);
};

function makeTask(items, category) {
  const first = items[0];
  // Collect dependencies first. If the second case repairs one, its baseline
  // replaces the support copy from the first case.
  const files = { "package.json": '{"type":"module","private":true}\n' };
  const referenceSolution = {};
  for (const item of items) {
    for (const dependency of item.dependencies ?? [])
      files[dependency] = read(item.commit, dependency);
  }
  for (const item of items) {
    files[item.file] = read(item.commit + "^", item.file);
    referenceSolution[item.file] = read(item.commit, item.file);
  }
  const diagnostic = category === "read-only-diagnosis";
  const long = category === "long-session";
  const expected = diagnostic
    ? { observed: first.before }
    : { verified: first.after, case: first.id };
  const finalFormat =
    "Return final JSON with keys " + Object.keys(expected).join(" and ") + ".";
  const turns = diagnostic
    ? [
        first.diagnosis +
          " Inspect the code without editing files. " +
          finalFormat,
      ]
    : long
      ? [
          "Investigate this case without editing. " + first.diagnosis,
          "For the final verification report, the exact case ID is " +
            first.id +
            ". Use the public behavior, not a count of changed lines.",
          first.prompt +
            " Apply changes only to " +
            first.file +
            " and verify them.",
          "Preserve the earlier case ID. For verified, return the boolean answer to the original diagnostic question after the repair. " +
            finalFormat,
        ]
      : [
          items.map((item) => item.file + " — " + item.prompt).join("\n") +
            "\nImplement the fix and verify the behavior. Edit only the listed source files.",
        ];
  return {
    id: category + "-" + first.id,
    category,
    critical: items.some((item) => item.critical),
    repositorySnapshot: snapshot(files),
    sourceRevisions: [...new Set(items.map((item) => item.commit))].sort(),
    files,
    turns,
    allowedChanges: diagnostic ? [] : Object.keys(referenceSolution),
    referenceSolution: diagnostic ? {} : referenceSolution,
    verifier: [
      verifierImports,
      ...items.map((item) =>
        behavior(item, diagnostic ? item.before : item.after),
      ),
      ...(diagnostic || long ? [answer(expected)] : []),
    ].join("\n"),
    ...(long ? { reopenBeforeTurn: 2 } : {}),
  };
}

export function holdoutTasks() {
  return [
    ...cases.map((item) => makeTask([item], "small-edit")),
    ...cases.map((item, index) =>
      makeTask([item, cases[(index + 2) % cases.length]], "multi-file-fix"),
    ),
    ...cases.map((item) => makeTask([item], "read-only-diagnosis")),
    ...cases.map((item) => makeTask([item], "long-session")),
  ];
}

export function verifyFrozenHoldout() {
  const root = mkdtempSync(join(tmpdir(), "gyro-holdout-check-"));
  try {
    const tasks = holdoutTasks();
    const verifier = join(root, "verifier.mjs");
    for (const task of tasks) {
      const workspace = join(root, task.id);
      const run = (files, response) => {
        for (const [path, data] of Object.entries(files)) {
          const target = join(workspace, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }
        writeFileSync(verifier, task.verifier);
        return execFileSync(process.execPath, ["--test", verifier], {
          env: {
            ...process.env,
            GYRO_VERIFY_WORKSPACE: workspace,
            GYRO_VERIFY_FINAL_RESPONSE: JSON.stringify(response),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      };
      const item = cases.find((candidate) => task.id.endsWith(candidate.id));
      const good =
        task.category === "read-only-diagnosis"
          ? { observed: item.before }
          : { verified: item.after, case: item.id };
      if (task.category === "read-only-diagnosis") {
        assert.throws(
          () => run(task.files, { observed: !item.before }),
          undefined,
          task.id,
        );
      } else {
        assert.throws(() => run(task.files, good), undefined, task.id);
      }
      run({ ...task.files, ...task.referenceSolution }, good);
      if (task.category === "long-session") {
        assert.throws(
          () => run(task.referenceSolution, { ...good, case: "wrong" }),
          undefined,
          task.id,
        );
      }
    }
    return tasks.length;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    "Validated " + verifyFrozenHoldout() + " historical Gyro scenarios.",
  );
}
