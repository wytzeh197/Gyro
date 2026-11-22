import assert from "node:assert/strict";
import {
  terminalOutputUpdate,
  mergeTerminalOutput,
} from "../apps/desktop/src/terminal-output.ts";

// PTY control bytes, including CR/LF split across reads, must be delivered once.
let rendered = "";
let previous = "";
for (const next of ["prompt\r", "prompt\r\n\x1b[", "prompt\r\n\x1b[2Kdone\n"]) {
  const update = terminalOutputUpdate(previous, next);
  assert.equal(update.reset, false);
  rendered += update.data;
  previous = next;
}
assert.equal(rendered, previous);
const retained = "abcdefghijklmnop".repeat(100);
assert.deepEqual(
  terminalOutputUpdate("old" + retained, retained + "\x1b[2Knew"),
  {
    reset: false,
    data: "\x1b[2Knew",
  },
);
assert.deepEqual(terminalOutputUpdate("old process", "new process"), {
  reset: true,
  data: "new process",
});
assert.deepEqual(terminalOutputUpdate("old process", ""), {
  reset: true,
  data: "",
});
assert.deepEqual(terminalOutputUpdate(retained, retained), {
  reset: false,
  data: "",
});
console.log("Terminal output regressions passed");

const cursor = (start, end, generation = "process-a") => ({
  start,
  end,
  generation,
});
const repeated = "x".repeat(512 * 1024);
assert.deepEqual(
  terminalOutputUpdate(
    repeated,
    repeated,
    cursor(0, repeated.length),
    cursor(8, repeated.length + 8),
  ),
  { reset: false, data: "xxxxxxxx" },
);
assert.deepEqual(terminalOutputUpdate("a", "a😀", cursor(0, 1), cursor(0, 5)), {
  reset: false,
  data: "😀",
});
assert.deepEqual(
  terminalOutputUpdate("same", "same", cursor(0, 4), cursor(0, 4, "process-b")),
  { reset: true, data: "same" },
);
assert.deepEqual(
  mergeTerminalOutput("hello", cursor(0, 5), "😀", cursor(5, 9)),
  { output: "hello😀", outputCursor: cursor(0, 9) },
);
assert.deepEqual(
  mergeTerminalOutput("hello", cursor(0, 5), null, cursor(0, 5)),
  { output: "hello", outputCursor: cursor(0, 5) },
);
const rolled = mergeTerminalOutput(
  repeated,
  cursor(0, repeated.length),
  "😀",
  cursor(repeated.length, repeated.length + 4),
);
assert.equal(new TextEncoder().encode(rolled.output).length, 512 * 1024);
assert.equal(rolled.outputCursor.start, 4);
assert.ok(rolled.output.endsWith("😀"));

const unicodePrefix = "😀" + repeated.slice(4);
const utf8Rollover = mergeTerminalOutput(
  unicodePrefix,
  cursor(12, 12 + repeated.length),
  "é",
  cursor(12 + repeated.length, 14 + repeated.length),
);
assert.equal(utf8Rollover.outputCursor.start, 16);
assert.equal(utf8Rollover.output, repeated.slice(4) + "é");
assert.deepEqual(
  terminalOutputUpdate(
    unicodePrefix,
    utf8Rollover.output,
    cursor(12, 12 + repeated.length),
    utf8Rollover.outputCursor,
  ),
  { reset: false, data: "é" },
);
const mixed = "line é😀\r\n".repeat(1024);
const mixedEnd = new TextEncoder().encode(mixed).length;
const update = "\x1b[2K😀\r\n";
assert.deepEqual(
  terminalOutputUpdate(
    mixed,
    mixed + update,
    cursor(0, mixedEnd),
    cursor(0, mixedEnd + new TextEncoder().encode(update).length),
  ),
  { reset: false, data: update },
);
assert.deepEqual(
  terminalOutputUpdate("", "😀", cursor(0, 2), cursor(0, 4)),
  { reset: false, data: "��" },
  "the byte decoder still handles a cursor inside a character",
);
console.log(
  "Terminal cursor, restart, repeated-output and UTF-8 delta checks passed",
);

assert.deepEqual(terminalOutputUpdate("", "\ufeff", cursor(0, 0), cursor(0, 3)), { reset: false, data: "\ufeff" }, "terminal byte positions must preserve a leading BOM too");
