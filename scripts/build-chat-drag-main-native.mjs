// Package the actual Gyro application for disposable native acceptance.
// No installation, launch, provider turn, or synthesized UI input happens here.
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeDebugExecutable } from "./build-native-debug-executable.mjs";

if (process.platform !== "darwin")
  throw Error("Native application acceptance requires macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const run = (program, args, env = process.env, timeout = 600000) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error(`${program} exceeded the acceptance build timeout.`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });

const argv = process.argv.slice(2);
if (argv.length && argv[0] !== "--prepare-only" && argv[0] !== "--finish")
  throw Error("Use --prepare-only or --finish <manifest.json>.");
let manifest;
let manifestPath;
if (argv[0] === "--finish") {
  if (argv.length !== 2)
    throw Error("--finish requires a prepared manifest path.");
  manifestPath = resolve(argv[1]);
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} else {
  const requested = process.env.GYRO_NATIVE_CHAT_DRAG_MAIN_ARTIFACTS
    ? resolve(process.env.GYRO_NATIVE_CHAT_DRAG_MAIN_ARTIFACTS)
    : await mkdtemp(join(tmpdir(), "gyro-chat-drag-main-native-"));
  await mkdir(requested, { recursive: true });
  const artifacts = await realpath(requested);
  const temporaryRoot = await realpath(tmpdir());
  if (
    artifacts === temporaryRoot ||
    artifacts === "/private/tmp" ||
    (!artifacts.startsWith(`${temporaryRoot}/`) &&
      !artifacts.startsWith("/private/tmp/"))
  ) {
    throw Error(
      "Acceptance artifacts must be in a disposable temporary directory.",
    );
  }
  const dataDir = await realpath(await mkdtemp(join(artifacts, "data-")));
  // The production sidebar excludes system-temporary workspaces. Keep the
  // project in an ignored, disposable checkout subdirectory while all native
  // application data remains under the validated temporary data root.
  const workspaceArtifactDir = await mkdtemp(
    join(root, "target/native-chat-drag-acceptance-"),
  );
  const workspacePath = join(workspaceArtifactDir, "Native drag project");
  await mkdir(workspacePath);
  await mkdir(join(dataDir, "sessions"));
  await writeFile(
    join(workspacePath, "README.txt"),
    "Disposable native splitview drag acceptance workspace. No provider turns are run.\n",
  );
  const sessions = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map(
    (name, index) => ({
      id: `baba0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      title: `Native ${name}`,
      draft: `${name} unsent native draft`,
    }),
  );
  const config = {
    automaticUpdateChecks: false,
    telemetryEnabled: false,
    requireCommandApproval: true,
    requireFileEditApproval: true,
    fullAccess: false,
    changeSummariesEnabled: false,
    modelProviders: [],
    commandProfiles: [],
  };
  await writeFile(
    join(dataDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  const expectedStatePath = join(artifacts, "seededExpectedState.json");
  await writeFile(
    expectedStatePath,
    `${JSON.stringify({ dataDir, workspacePath, sessions, initiallyOpenSessionIds: [sessions[0].id], config }, null, 2)}\n`,
  );
  const seedScript = join(artifacts, "seed-sessions.py");
  await writeFile(
    seedScript,
    `import json, pathlib, sqlite3, uuid\nseed=json.loads(pathlib.Path(${JSON.stringify(expectedStatePath)}).read_text())\nroot=pathlib.Path(seed['dataDir'])\nconn=sqlite3.connect(root/'gyro.sqlite3')\nconn.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, workspace_path TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, events_path TEXT NOT NULL)')\nfor index, session in enumerate(seed['sessions']):\n    timestamp=f'2026-10-11T12:00:{4-index:02d}+00:00'\n    event_path=root/'sessions'/(session['id']+'.jsonl')\n    events=[]\n    for kind, message in [('session-created', 'Session created'), ('user-message', 'Native drag acceptance sample '+session['title']), ('assistant-message', 'Safe local sample transcript for '+session['title'])]:\n        events.append({'id':str(uuid.uuid4()), 'sessionId':session['id'], 'createdAt':timestamp, 'kind':kind, 'message':message, 'payload':{}})\n    event_path.write_text(''.join(json.dumps(event)+'\\n' for event in events))\n    event_path.chmod(0o600)\n    conn.execute('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)', (session['id'], session['title'], seed['workspacePath'], 'desktop', timestamp, timestamp, str(event_path)))\nconn.commit()\nconn.close()\n(root/'gyro.sqlite3').chmod(0o600)\n`,
  );
  if (await run("/usr/bin/python3", [seedScript]))
    throw Error("Disposable session seeding failed.");
  const frontendDir = join(artifacts, "frontend");
  const viteConfigPath = join(artifacts, "vite.config.mjs");
  await writeFile(
    viteConfigPath,
    `import base from ${JSON.stringify(join(desktop, "vite.config.ts"))};\nexport default async (environment) => {\n const config = typeof base === 'function' ? await base(environment) : await base;\n return { ...config, root: ${JSON.stringify(desktop)}, build: { ...config.build, outDir: ${JSON.stringify(frontendDir)}, emptyOutDir: true, rollupOptions: { ...config.build?.rollupOptions, input: { index: ${JSON.stringify(join(desktop, "index.html"))}, 'chat-drag-main-native': ${JSON.stringify(join(desktop, "chat-drag-main-native.html"))}, 'chat-drag-preview': ${JSON.stringify(join(desktop, "chat-drag-preview.html"))} } } } };\n};\n`,
  );
  const baseConfig = JSON.parse(
    await readFile(join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const title = "Gyro main chat drag native";
  const identifier = "dev.gyro.chat-drag-main-native";
  const nativeConfig = {
    identifier,
    productName: title,
    build: { frontendDist: frontendDir },
    app: {
      windows: baseConfig.app.windows.map((window, index) =>
        index === 0
          ? {
              ...window,
              label: "main",
              title,
              url: "chat-drag-main-native.html",
            }
          : window,
      ),
    },
  };
  const nativeConfigPath = join(artifacts, "native-config.json");
  await writeFile(
    nativeConfigPath,
    `${JSON.stringify(nativeConfig, null, 2)}\n`,
  );
  const frontendEnv = {
    ...process.env,
    VITE_GYRO_NATIVE_CHAT_DRAG_MAIN_SEED: JSON.stringify({
      dataDir,
      workspacePath,
      sessions,
    }),
  };
  if (
    await run(
      "pnpm",
      [
        "--filter",
        "@gyro-dev/desktop",
        "exec",
        "vite",
        "build",
        "--config",
        viteConfigPath,
        "--mode",
        "native-chat-drag-main",
        "--logLevel",
        "warn",
      ],
      frontendEnv,
    )
  ) {
    throw Error("Full application native frontend build failed.");
  }
  manifestPath = join(artifacts, "manifest.json");
  manifest = {
    status: "prepared",
    artifacts,
    dataDir,
    workspacePath,
    workspaceArtifactDir,
    frontendDir,
    nativeConfigPath,
    expectedStatePath,
    identifier,
    title,
    appPath: join(artifacts, `${title}.app`),
    binary: null,
    nativeBuild: "actual-main-debug-embedded-tauri",
    manifestPath,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (argv[0] === "--prepare-only") {
  console.log(
    `Full native application assets and disposable state prepared.\n${JSON.stringify(manifest, null, 2)}`,
  );
} else {
  const nativeConfig = JSON.parse(
    await readFile(manifest.nativeConfigPath, "utf8"),
  );
  const buildEnv = {
    ...process.env,
    TAURI_CONFIG: JSON.stringify(nativeConfig),
  };
  // --finish also accepts older prepared manifests with an assumed binary path.
  // Replace that path with the executable emitted by this successful build.
  manifest.binary = await buildNativeDebugExecutable({
    root,
    bin: "gyro-desktop",
    features: ["tauri/custom-protocol"],
    env: buildEnv,
  });
  manifest.nativeDebugAssertions = true;
  const macosDir = join(manifest.appPath, "Contents/MacOS");
  const resourcesDir = join(manifest.appPath, "Contents/Resources");
  await mkdir(macosDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await copyFile(manifest.binary, join(macosDir, "gyro-desktop"));
  await chmod(join(macosDir, "gyro-desktop"), 0o755);
  await writeFile(
    join(resourcesDir, "fixture-data-dir"),
    `${manifest.dataDir}\n`,
  );
  const launcherPath = join(manifest.artifacts, "launcher.c");
  await writeFile(
    launcherPath,
    `#include <mach-o/dyld.h>\n#include <limits.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\nint main(void) {\n char executable[PATH_MAX], canonical[PATH_MAX], data[PATH_MAX], binary[PATH_MAX];\n uint32_t size=sizeof(executable);\n if (_NSGetExecutablePath(executable, &size) || !realpath(executable, canonical)) return 2;\n char *slash=strrchr(canonical, '/'); if (!slash) return 2; *slash='\\0';\n if (snprintf(binary,sizeof(binary),"%s/gyro-desktop",canonical)>=sizeof(binary)) return 2;\n if (snprintf(executable,sizeof(executable),"%s/../Resources/fixture-data-dir",canonical)>=sizeof(executable)) return 2;\n FILE *file=fopen(executable,"r"); if (!file || !fgets(data,sizeof(data),file)) return 2; fclose(file);\n data[strcspn(data,"\\r\\n")]='\\0';\n if (!realpath(data,canonical) || (strncmp(canonical,"/private/tmp/",13) && strncmp(canonical,"/private/var/folders/",21))) return 2;\n if (setenv("GYRO_TEST_DATA_DIR",canonical,1)) return 2;\n unsetenv("GYRO_TEST_PERSIST_UI"); unsetenv("GYRO_PERFORMANCE_BENCHMARK"); unsetenv("GYRO_BROWSER_SMOKE_URL"); unsetenv("GYRO_LSP_SMOKE");\n execl(binary,"gyro-desktop",(char *)0); perror("launch Gyro native acceptance"); return 2;\n}\n`,
  );
  if (
    await run("/usr/bin/clang", [
      launcherPath,
      "-o",
      join(macosDir, "gyro-native-test-launcher"),
    ])
  )
    throw Error("Acceptance environment launcher build failed.");
  await writeFile(
    join(manifest.appPath, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>CFBundleExecutable</key><string>gyro-native-test-launcher</string>\n<key>CFBundleIdentifier</key><string>${manifest.identifier}</string>\n<key>CFBundleName</key><string>${manifest.title}</string>\n<key>CFBundleDisplayName</key><string>${manifest.title}</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleShortVersionString</key><string>0.1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>LSMinimumSystemVersion</key><string>14.0</string>\n<key>NSHighResolutionCapable</key><true/>\n</dict></plist>\n`,
  );
  if (
    await run("codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      manifest.appPath,
    ])
  )
    throw Error("Acceptance application ad hoc signing failed.");
  manifest.status = "packaged";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Actual Gyro native application packaged; launch and operate it through CUA.\n${JSON.stringify(manifest, null, 2)}`,
  );
}
