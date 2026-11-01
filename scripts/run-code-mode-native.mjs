import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const data = mkdtempSync(join(tmpdir(), "gyro-code-mode-"));
const child = spawn(
  process.env.GYRO_CODE_MODE_SMOKE_BINARY ?? "cargo",
  process.env.GYRO_CODE_MODE_SMOKE_BINARY
    ? []
    : ["run", "-p", "gyro-desktop", "--bin", "gyro-desktop"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      GYRO_TEST_DATA_DIR: data,
      GYRO_CODE_MODE_SMOKE: "1",
      GYRO_CODE_MODE: "1",
    },
  },
);
const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timer);
assert.equal(code, 0, "Native Code Mode acceptance failed");
const report = JSON.parse(
  readFileSync(join(data, "code-mode-smoke.json"), "utf8"),
);
assert.equal(report.ok, true);
console.log(
  JSON.stringify(
    { reportPath: join(data, "code-mode-smoke.json"), ...report },
    null,
    2,
  ),
);
