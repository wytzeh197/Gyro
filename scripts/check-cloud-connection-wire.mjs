// Explicit cross-repository acceptance, not part of public app startup/build.
// Owns and cleans up one disposable simulator; never launches native UI.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const mockRoot = process.argv[2];
if (!mockRoot)
  throw new Error("Supply the separate private gyro-cloud checkout path");
const free = createServer();
await new Promise((ok, fail) => {
  free.once("error", fail);
  free.listen(0, "127.0.0.1", ok);
});
const port = free.address().port;
await new Promise((ok) => free.close(ok));
const env = { ...process.env, GYRO_CLOUD_MOCK_PORT: String(port) };
const server = spawn(
  process.execPath,
  ["--import", "tsx", "src/connection-mock-server.ts"],
  { cwd: resolve(mockRoot), env, stdio: ["ignore", "pipe", "pipe"] },
);
let probe;
const stop = () => {
  probe?.kill("SIGTERM");
  server.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await new Promise((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error("Local mock did not become ready")),
      10_000,
    );
    server.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Local mock exited ${code}`));
    });
    server.stdout.on("data", (data) => {
      if (String(data).includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        ok();
      }
    });
    server.stderr.on("data", (data) => process.stderr.write(data));
  });
  probe = spawn(
    "cargo",
    ["run", "-p", "gyro-core", "--example", "cloud_connection_probe"],
    { cwd: root, env, stdio: "inherit" },
  );
  const code = await new Promise((ok, fail) => {
    probe.once("error", fail);
    probe.once("exit", ok);
  });
  if (code !== 0)
    throw new Error(`Headless Cloud connection probe failed (${code})`);
} finally {
  stop();
  if (server.exitCode === null && server.signalCode === null)
    await new Promise((ok) => server.once("exit", ok));
}
