import assert from "node:assert/strict";

import {
  buildTerminalFailureContext,
  extractTerminalFileReferences,
  isTerminalErrorLine,
  stripTerminalControl,
  terminalOutputHasError,
} from "../packages/ui/src/terminal-failure.ts";

// Colour, cursor and hyperlink control is removed; CR redraws keep the last frame.
assert.equal(
  stripTerminalControl(
    "\u001b[33mwarning\u001b[0m: unused\r\n\u001b]8;;https://x\u0007link\u001b]8;;\u0007\n10%\r50%\r100% done",
  ),
  "warning: unused\nlink\n100% done",
);

// Compiler and runner errors count; warnings and passing summaries do not.
for (const line of [
  "error[E0425]: cannot find value `x` in this scope",
  "src/App.tsx(12,3): error TS2304: Cannot find name 'foo'.",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "thread 'main' panicked at src/main.rs:4:5:",
  " FAIL  src/queue.test.ts > promotes the head",
  "npm ERR! code ELIFECYCLE",
  "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL",
  "Traceback (most recent call last):",
  "error: could not compile `gyro-desktop` (lib) due to 1 previous error",
]) {
  assert.ok(isTerminalErrorLine(line), line);
}
for (const line of [
  "warning: method `read` is never used",
  "test result: ok. 10 passed; 0 failed; 0 ignored",
  "Finished `dev` profile [unoptimized + debuginfo] target(s) in 33.03s",
  "Compiling gyro-desktop v0.1.0",
]) {
  assert.ok(!isTerminalErrorLine(line), line);
}
assert.ok(!terminalOutputHasError("warning: unused\nFinished dev"));
assert.ok(terminalOutputHasError("Compiling\n\u001b[31merror\u001b[0m: boom"));

// Only workspace files are referenced, relative, deduplicated and capped at 5.
assert.deepEqual(
  extractTerminalFileReferences(
    [
      "  --> apps/desktop/src-tauri/src/usage_poll.rs:19:19",
      "/Users/me/Gyro/packages/ui/src/types.ts:324:3 - error",
      "/opt/other/lib.ts:1:1",
      "node_modules/react/index.js:10:2",
      "  --> apps/desktop/src-tauri/src/usage_poll.rs:40:1",
      "Local: http://127.0.0.1:1420/",
      "./src/App.tsx:8:1",
    ].join("\n"),
    "/Users/me/Gyro/",
  ),
  [
    { path: "apps/desktop/src-tauri/src/usage_poll.rs", line: 19, column: 19 },
    { path: "packages/ui/src/types.ts", line: 324, column: 3 },
    { path: "src/App.tsx", line: 8, column: 1 },
  ],
);

// The first error survives a long run, the tail is kept, gaps are marked.
const noise = Array.from(
  { length: 300 },
  (_, index) => `Compiling crate-${index}`,
);
const output = [
  ...noise.slice(0, 100),
  "error[E0425]: cannot find value `x` in this scope",
  "  --> src/main.rs:4:5",
  ...noise.slice(100),
  "error: could not compile `app` due to 1 previous error",
].join("\n");
const context = buildTerminalFailureContext({
  label: "cargo check",
  command: "cargo check",
  workingDirectory: "/Users/me/Gyro",
  exitCode: 101,
  status: "failed",
  branch: "main",
  output,
  capturedAt: "2026-09-22T12:00:00.000Z",
});
assert.equal(context.name, "cargo-check-output.txt");
assert.match(
  context.text,
  /^Terminal output from cargo check\nCommand: cargo check\n/,
);
assert.match(context.text, /Exit code: 101 \(failed\)/);
assert.match(context.text, /Referenced files: src\/main\.rs:4/);
assert.match(
  context.text,
  /re-run `cargo check` from \/Users\/me\/Gyro with the terminal tool/,
);
assert.match(context.text, /error\[E0425\]/);
assert.match(context.text, /could not compile `app`/);
assert.match(context.text, /… \d+ lines omitted/);
assert.ok(!context.text.includes("Compiling crate-50\n"));
assert.ok(context.omittedLines > 0);
assert.deepEqual(context.referencedFiles, [
  { path: "src/main.rs", line: 4, column: 5 },
]);

// A selection is sent as chosen, and oversized output is capped.
const selection = buildTerminalFailureContext({
  label: "pnpm desktop:dev",
  output: "Compiling a\nCompiling b",
  isSelection: true,
});
assert.equal(selection.name, "pnpm-desktop-dev-selection.txt");
assert.match(selection.text, /Compiling a\nCompiling b/);
assert.ok(!selection.text.includes("re-run"));

const huge = buildTerminalFailureContext(
  {
    label: "big",
    output: Array.from(
      { length: 5_000 },
      (_, i) => `error: line ${i} ${"x".repeat(40)}`,
    ).join("\n"),
  },
  { maxChars: 4_000 },
);
assert.ok(huge.text.length <= 4_200, String(huge.text.length));
assert.match(huge.text, /error: line 0 /);
assert.match(huge.text, /error: line 4999 /);
assert.match(huge.text, /lines omitted to fit the attachment/);

console.log("Terminal failure context checks passed.");
