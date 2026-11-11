// A renderer contract job owns only the Vite process it starts. Existing
// desktop development servers are reused and left running.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
const reachable = async () => {
  try {
    return (
      await fetch(`${origin}/capture.html`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
};
let server;
let check;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    check?.kill(signal);
    server?.kill("SIGTERM");
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
try {
  if (!(await reachable())) {
    if (process.argv.includes("--no-start"))
      throw new Error(
        `Expected an existing capture server at ${origin}; auto-start is disabled.`,
      );
    const url = new URL(origin);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Auto-start is restricted to loopback origins.");
    const require = createRequire(
      new URL("../apps/desktop/package.json", import.meta.url),
    );
    const vite = resolve(
      dirname(require.resolve("vite/package.json")),
      "bin/vite.js",
    );
    server = spawn(
      process.execPath,
      [
        vite,
        "--host",
        url.hostname,
        "--port",
        url.port || "1420",
        "--strictPort",
      ],
      {
        cwd: resolve(root, "apps/desktop"),
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    const deadline = Date.now() + 60_000;
    while (
      Date.now() < deadline &&
      server.exitCode === null &&
      !(await reachable())
    )
      await new Promise((resolve) => setTimeout(resolve, 200));
    if (!(await reachable()))
      throw new Error(`Vite did not serve ${origin}/capture.html`);
  }
  check = spawn(
    process.execPath,
    [
      resolve(root, "scripts/check-chat-render-snapshot.mjs"),
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      env: { ...process.env, GYRO_TEST_ORIGIN: origin },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve, reject) => {
    check.once("error", reject);
    check.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  server?.kill("SIGTERM");
}
