#!/usr/bin/env node
/**
 * The WebView dialogs guard.
 *
 * The macOS window Gyro ships is a `WKWebView` (wry), and its UI delegate
 * implements no JavaScript panel methods. WebKit suppresses the dialog and
 * `prompt()` returns null, `confirm()` returns false, `alert()` does nothing —
 * silently. Anything gated on one cancels itself with no dialog, no error and
 * no trace, which is how file rename, chat rename and terminal rename all
 * stopped working at once.
 *
 * This guard fails the build when a webview dialog reappears, and pins the two
 * halves of the workspace change bridge together: every lifecycle command and
 * the model-facing capability must announce through the same helper, and the
 * editor must listen for that event.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

const WEBVIEW_DIALOG = /\bwindow\.(prompt|alert)\s*\(/;
const WEBVIEW_CONFIRM = /\bwindow\.confirm\s*\(/;
/* The one place a plain `confirm` is deliberately allowed: the wrapper that
   understands a host without native dialogs. */
const CONFIRM_WRAPPER = "packages/ui/src/confirm-action.ts";

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* sourceFiles(path);
      continue;
    }
    if (/\.(ts|tsx|mts|cts)$/.test(entry)) yield path;
  }
}

for (const directory of ["apps/desktop/src", "packages/ui/src"]) {
  for (const file of sourceFiles(join(root, directory))) {
    const relativePath = relative(root, file);
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, index) => {
      const where = `${relativePath}:${index + 1}`;
      if (WEBVIEW_DIALOG.test(line)) {
        failures.push(`${where} uses a WebView dialog that never opens: ${line.trim()}`);
      }
      if (WEBVIEW_CONFIRM.test(line) && relativePath !== CONFIRM_WRAPPER) {
        failures.push(`${where} calls window.confirm outside the dialog wrapper: ${line.trim()}`);
      }
    });
  }
}

const read = (path) => readFileSync(join(root, path), "utf8");
const lib = read("apps/desktop/src-tauri/src/lib.rs");
const capability = read("apps/desktop/src-tauri/src/workspace_path_capability.rs");
const app = read("apps/desktop/src/App.tsx");

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

expect(
  lib.includes('const WORKSPACE_PATHS_CHANGED_EVENT: &str = "gyro://workspace-paths-changed";'),
  "lib.rs has no workspace path-change event, so open editors cannot follow a rename",
);
for (const command of [
  "create_workspace_file",
  "rename_workspace_path",
  "delete_workspace_path",
]) {
  const start = lib.indexOf(`async fn ${command}(`);
  expect(start >= 0, `lib.rs no longer defines the ${command} command`);
  if (start < 0) continue;
  /* The announcement sits in the spawn_blocking closure at the top of the
     command, well inside this window. */
  const body = lib.slice(start, start + 1200);
  expect(
    body.includes("run_workspace_lifecycle("),
    `${command} does not announce its change through run_workspace_lifecycle`,
  );
}
expect(
  capability.includes("emit_workspace_path_change(app, change);"),
  "the model capability does not announce its change, so a model rename never reaches the editor",
);
expect(
  /workspace_rename_path|WorkspaceRenamePath/.test(capability),
  "the model capability no longer renames workspace paths",
);
expect(
  app.includes('"gyro://workspace-paths-changed"'),
  "App.tsx does not listen for workspace path changes",
);
expect(
  app.includes("askTextValue("),
  "App.tsx does not use the in-app prompt",
);

if (failures.length > 0) {
  console.error(`check-webview-dialogs: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("check-webview-dialogs: no webview dialogs, workspace bridge announced on both sides");
