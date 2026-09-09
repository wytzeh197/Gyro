import assert from "node:assert/strict";
import { terminalOutputUpdate } from "../apps/desktop/src/terminal-output.ts";

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
