// Manual native acceptance of the normal App entrypoint, without model turns.
// Build assets, app identity, store, workspace, captures and socket are isolated.
// This runner records lifecycle only; its exit status is not a UI test verdict.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeDebugExecutable } from "./build-native-debug-executable.mjs";

if (process.platform !== "darwin")
  throw Error("Native shell review requires macOS");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reuseAt = process.argv.indexOf("--reuse");
const root = await realpath(
  reuseAt < 0
    ? await mkdtemp("/private/tmp/gyro-shell-")
    : process.argv[reuseAt + 1],
);
if (!/^\/private\/tmp\/gyro-shell-[A-Za-z0-9]+$/.test(root))
  throw Error("The review root must be its own short temporary directory");
const data = join(root, "data");
const frontend = join(root, "frontend");
// Normal sidebar rules intentionally hide system-temporary projects. A
// clearly owned repository fixture lets native drag/split acceptance use the
// real sidebar, without changing those rules or forging imported metadata.
const visibleWorkspace = process.argv.includes("--visible-workspace");
const workspace = visibleWorkspace
  ? join(
      repo,
      "docs/performance/2026-11-08-browser-split/projects",
      basename(root),
      "Browser acceptance",
    )
  : join(root, "workspace");
if (
  reuseAt >= 0 &&
  (await readFile(join(data, ".native-shell-review"), "utf8")) !==
    "isolated-native-shell-review\n"
)
  throw Error("The review root is missing its isolation marker");
for (const path of [data, frontend, workspace])
  await mkdir(path, { recursive: true });
const workspaceMarker = join(workspace, ".native-shell-review-workspace");
const workspaceIdentity = `${data}\n`;
try {
  if ((await readFile(workspaceMarker, "utf8")) !== workspaceIdentity)
    throw Error("The review workspace belongs to a different temporary store");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(workspaceMarker, workspaceIdentity, { flag: "wx" });
}
await writeFile(
  join(data, ".native-shell-review"),
  "isolated-native-shell-review\n",
);
await writeFile(
  join(workspace, "README.md"),
  "# Browser shell acceptance\n\nDisposable workspace for native browser acceptance.\n",
);
const identifier = `dev.gyro.browser-shell-review.${basename(root)}`;
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("GYRO_")) delete env[key];
env.GYRO_TEST_DATA_DIR = data;
env.GYRO_NATIVE_BROWSER_SHELL_DATA_DIR = data;
env.GYRO_NATIVE_BROWSER_SHELL_WORKSPACE = workspace;
env.TAURI_CONFIG = JSON.stringify({
  identifier,
  productName: "Gyro Browser Shell Review",
  build: { frontendDist: frontend },
  app: {
    security: {
      assetProtocol: {
        scope: [
          join(data, "browser-captures/**"),
          join(data, "sessions/attachments/**"),
        ],
      },
    },
  },
});
const manifest = {
  root,
  data,
  workspace,
  visibleWorkspace,
  frontend,
  identifier,
  mode: "normal-app-manual-review",
  build: "pending",
  uiVerdict: "unverified",
};
const save = () =>
  writeFile(
    join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
await save();
console.log(`Native browser shell evidence: ${root}`);

async function run(program, args) {
  await new Promise((ok, fail) => {
    const child = spawn(program, args, { cwd: repo, env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      code === 0 && !signal
        ? ok()
        : fail(Error(`${program} failed (${signal ?? code})`));
    });
  });
}
if (visibleWorkspace)
  await run("git", ["-C", workspace, "init", "--initial-branch=main"]);
await run("pnpm", [
  "--filter",
  "@gyro-dev/desktop",
  "exec",
  "vite",
  "build",
  "--outDir",
  frontend,
  "--emptyOutDir",
  "--logLevel",
  "warn",
]);
manifest.binary = await buildNativeDebugExecutable({
  root: repo,
  bin: "gyro-browser-shell-review",
  features: ["native-browser-shell-review"],
  env,
});
const contents = join(root, "Gyro Browser Shell Review.app", "Contents");
await mkdir(join(contents, "MacOS"), { recursive: true });
const executable = join(contents, "MacOS", "gyro-browser-shell-review");
await copyFile(manifest.binary, executable);
manifest.executableSha256 = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex");
await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>gyro-browser-shell-review</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Gyro Browser Shell Review</string>
<key>CFBundleDisplayName</key><string>Gyro Browser Shell Review</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
);
manifest.app = dirname(contents);
manifest.build = "passed";
if (process.argv.includes("--seed-chats")) {
  await run(executable, ["--seed-review-chats"]);
  manifest.seededChats = JSON.parse(
    await readFile(join(data, "native-shell-chats.json"), "utf8"),
  );
}
const fixture = await readFile(
  join(repo, "scripts/fixtures/browser-observation.html"),
  "utf8",
);
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/browser-observation.html") {
    response.writeHead(404).end();
    return;
  }
  const label =
    url.searchParams.get("page") === "second" ? "Second" : "Original";
  requests.push({ page: label, at: new Date().toISOString() });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    fixture
      .replace("Browser observation ready", `Shell ${label} ready`)
      .replace(
        "</body>",
        '<nav><a href="?page=second">Open second fixture page</a></nav></body>',
      ),
  );
});
await new Promise((ok, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", ok);
});
manifest.fixtureUrl = `http://127.0.0.1:${server.address().port}/browser-observation.html`;
const runtimeEnv = { ...env };
delete runtimeEnv.GYRO_TEST_DATA_DIR;
delete runtimeEnv.GYRO_NATIVE_BROWSER_SHELL_DATA_DIR;
delete runtimeEnv.GYRO_NATIVE_BROWSER_SHELL_WORKSPACE;
const child = spawn(executable, [], {
  cwd: repo,
  env: runtimeEnv,
  stdio: "inherit",
});
manifest.native = {
  status: "running",
  pid: child.pid,
  startedAt: new Date().toISOString(),
};
await save();
console.log(
  JSON.stringify({
    app: manifest.app,
    fixtureUrl: manifest.fixtureUrl,
    workspace,
  }),
);
const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timeout = setTimeout(stop, 1800000);
try {
  const result = await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => ok({ code, signal }));
  });
  manifest.native = {
    ...manifest.native,
    status: "exited",
    ...result,
    exitedAt: new Date().toISOString(),
  };
} finally {
  clearTimeout(timeout);
  server.close();
  manifest.requests = requests;
  manifest.executableUnchanged =
    manifest.executableSha256 ===
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
  await save();
}
console.log(
  JSON.stringify({
    lifecycle: manifest.native,
    uiVerdict: manifest.uiVerdict,
    evidence: root,
  }),
);
