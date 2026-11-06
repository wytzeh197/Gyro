import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const tool = {
  name: "gyro_workspace_read",
  description: "Read a file",
  schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
function run(
  code,
  invoke = async (input) => ({ data: input.path }),
  tools = [tool],
) {
  return new Promise((resolve, reject) => {
    const child = process.env.GYRO_CODE_MODE_WORKER
      ? spawn(process.env.GYRO_CODE_MODE_WORKER, [], {
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(
          process.execPath,
          [fileURLToPath(new URL("worker.mjs", import.meta.url))],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Worker test timed out"));
    }, 10000);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const reader = createInterface({ input: child.stdout });
    reader.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "call") {
        try {
          child.stdin.write(
            JSON.stringify({
              type: "response",
              id: msg.id,
              value: await invoke(msg.input),
            }) + "\n",
          );
        } catch (error) {
          child.stdin.write(
            JSON.stringify({
              type: "response",
              id: msg.id,
              error: error.message,
            }) + "\n",
          );
        }
      } else if (msg.type === "result") {
        clearTimeout(timer);
        child.kill();
        resolve(msg.outcome);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) reject(new Error(stderr));
    });
    child.stdin.write(JSON.stringify({ type: "start", code, tools }) + "\n");
  });
}
test("composes dependent calls and preserves results", async () => {
  const result = await run(
    "const first=await tools.gyro_workspace_read({path:'one'}); return (await tools.gyro_workspace_read({path:first.data+'-two'})).data;",
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, "one-two");
});
test("host facilities and unsupported tools are inaccessible", async () => {
  for (const source of [
    "return process.env",
    "return fetch('https://example.com')",
    "import fs from 'node:fs'",
    "return tools.gyro_workspace_edit({})",
  ]) {
    assert.equal(
      (
        await run(source, () => {
          throw new Error("Host should not be called");
        })
      ).ok,
      false,
    );
  }
});
test("failure retains earlier host work and does not replay it", async () => {
  let calls = 0;
  const result = await run(
    "await tools.gyro_workspace_read({path:'one'}); await tools.gyro_workspace_read({path:'two'});",
    async (input) => {
      calls++;
      if (input.path === "two") throw new Error("Denied by policy");
      return { data: "retained" };
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});
test("source and tool-call limits are enforced", async () => {
  assert.equal((await run("x".repeat(16385))).ok, false);
  let calls = 0;
  const result = await run(
    "for(let i=0;i<100;i++) await tools.gyro_workspace_read({path:'one'});",
    async () => {
      calls++;
      return {};
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 32);
});
test("result shortening is explicit", async () => {
  const result = await run("return 'a'.repeat(30000)");
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
});
