import test from "node:test";
import assert from "node:assert/strict";
import { drain } from "./sync.mjs";
test("recovers after a transient failure", async () => {
  let calls = 0;
  const waits = [];
  const result = await drain(
    async () => {
      if (++calls < 2) throw new Error("503");
      return "sent";
    },
    async (ms) => waits.push(ms),
  );
  assert.equal(result, "sent");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [100]);
});
test("stops after five failed attempts", async () => {
  let calls = 0;
  const waits = [];
  const error = new Error("503");
  await assert.rejects(
    drain(
      async () => {
        calls++;
        throw error;
      },
      async (ms) => waits.push(ms),
    ),
    (e) => e === error,
  );
  assert.equal(calls, 5);
  assert.deepEqual(waits, [100, 200, 400, 800]);
});
