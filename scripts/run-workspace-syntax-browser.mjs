// Snapshot the production-component fixture before testing, so concurrent Vite
// HMR edits cannot reset navigation, preview or recovery state during the run.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const temporary = await mkdtemp(
  join(tmpdir(), "gyro-workspace-syntax-fixture-"),
);
const dist = join(temporary, "dist");
const config = join(temporary, "vite.config.mjs");
const port = Number(process.env.GYRO_FIXTURE_PORT ?? "1423");
const origin = `http://127.0.0.1:${port}`;
await writeFile(
  config,
  `export default ${JSON.stringify({
    root: desktop,
    logLevel: "warn",
    esbuild: { jsx: "automatic" },
    define: {
      "import.meta.env.DEV": "true",
      "process.env.NODE_ENV": '"development"',
    },
    build: {
      outDir: dist,
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, "workspace-syntax-fixture.html"),
      },
    },
  })};`,
);
const run = (program, args, options = {}) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
let server;
try {
  const built = await run(
    process.execPath,
    [vite, "build", "--config", config],
    { env: { ...process.env, NODE_ENV: "development" } },
  );
  if (built) throw Error(`Fixture build failed (${built}).`);
  server = spawn(
    process.execPath,
    [
      vite,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      dist,
    ],
    { cwd: desktop, stdio: ["ignore", "ignore", "inherit"] },
  );
  let ready = false;
  for (let attempts = 0; attempts < 100; attempts++) {
    if (server.exitCode !== null)
      throw Error("Fixture preview server exited before starting.");
    try {
      if ((await fetch(`${origin}/workspace-syntax-fixture.html`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolvePause) => setTimeout(resolvePause, 100));
  }
  if (!ready) throw Error("Fixture preview server did not start.");
  const checked = await run(
    process.execPath,
    [join(root, "scripts/check-workspace-syntax-browser.mjs")],
    { env: { ...process.env, GYRO_TEST_ORIGIN: origin } },
  );
  process.exitCode = checked;
  for (const fault of ["wasm", "grammar"]) {
    const retryChecked = await run(
      process.execPath,
      [join(root, "scripts/check-workspace-syntax-browser.mjs")],
      {
        env: {
          ...process.env,
          GYRO_TEST_ORIGIN: origin,
          GYRO_TEST_FAULT: fault,
          GYRO_TEST_ARTIFACTS: `/private/tmp/gyro-workspace-syntax-browser/retry-${fault}`,
        },
      },
    );
    if (retryChecked) process.exitCode = retryChecked;
  }
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolveStop) =>
      server.exitCode !== null
        ? resolveStop()
        : server.once("exit", resolveStop),
    );
  }
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
