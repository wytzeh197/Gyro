#!/usr/bin/env node
// Multi-root workspace policy: validation, health, canonical storage, and
// relocation. The filesystem half is covered by `gyro_core::workspace_roots`
// tests; these inputs stand in for what `inspect_workspace_folders` returns.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessWorkspaceRoots,
  relocateWorkspaceFolderPreferences,
  validateWorkspaceRoots,
  workspaceRootIssueSummary,
} from "../packages/ui/src/workspace-roots.ts";
import {
  MAX_WORKSPACE_FOLDERS,
  normalizedWorkspaceFolderList,
  parseGyroWorkspaceFile,
  workspaceFolderPaths,
} from "../packages/ui/src/workspace-project.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

const ok = (path, canonicalPath = path) => ({
  path,
  canonicalPath,
  status: "ok",
});
const gone = (path) => ({ path, status: "missing" });

// --- validateWorkspaceRoots -------------------------------------------------

{
  const existing = [ok("/work/app"), ok("/tmp/shared", "/private/tmp/shared")];
  const result = validateWorkspaceRoots({
    existing,
    candidates: [
      ok("/private/tmp/shared"), // same identity, other spelling
      ok("/work/app/packages/ui"), // inside the primary
      ok("/work"), // contains the primary
      gone("/Volumes/USB/docs"),
      {
        path: "/etc/hosts",
        canonicalPath: "/private/etc/hosts",
        status: "not-directory",
      },
      ok("/work/docs/"), // fine; trailing slash normalized
      ok("/work/docs"), // now a repeat of the one just accepted
      ok("/link/lib", "/real/lib"),
    ],
  });
  assert.deepEqual(result.accepted, ["/work/docs", "/real/lib"]);
  assert.deepEqual(result.canonicalByPath, {
    "/work/docs": "/work/docs",
    "/link/lib": "/real/lib",
  });
  assert.deepEqual(
    result.issues.map((issue) => [issue.path, issue.code]),
    [
      ["/private/tmp/shared", "duplicate"],
      ["/work/app/packages/ui", "overlap"],
      ["/work", "overlap"],
      ["/Volumes/USB/docs", "missing"],
      ["/etc/hosts", "not-directory"],
      ["/work/docs", "duplicate"],
    ],
  );
  assert.equal(result.issues[0].relatedPath, "/tmp/shared");
  assert.match(result.issues[1].message, /^Inside app,/);
  assert.match(result.issues[2].message, /^Contains app,/);
  assert.equal(result.issues[3].message, "Folder not found");
}

{
  const nested = validateWorkspaceRoots({
    existing: [ok("/work/app")],
    candidates: [ok("/work/app/packages/ui")],
    allowNested: true,
  });
  assert.deepEqual(nested.accepted, ["/work/app/packages/ui"]);

  // `/` contains everything; the boundary check must not treat `/a` as `/ab`.
  const root = validateWorkspaceRoots({
    existing: [ok("/a")],
    candidates: [ok("/"), ok("/ab")],
  });
  assert.deepEqual(root.accepted, ["/ab"]);
  assert.equal(root.issues[0].code, "overlap");
}

{
  // The cap counts unavailable roots too: they keep their slot.
  const existing = [
    ok("/p"),
    ...Array.from({ length: MAX_WORKSPACE_FOLDERS - 2 }, (_, i) =>
      ok(`/x${i}`),
    ),
    gone("/Volumes/USB/old"),
  ];
  assert.equal(existing.length, MAX_WORKSPACE_FOLDERS);
  const capped = validateWorkspaceRoots({
    existing,
    candidates: [ok("/one-more")],
  });
  assert.deepEqual(capped.accepted, []);
  assert.equal(capped.issues[0].code, "cap-exceeded");
  assert.match(capped.issues[0].message, /up to 20 folders/);

  const fills = validateWorkspaceRoots({
    existing: existing.slice(0, -1),
    candidates: [ok("/last"), ok("/overflow")],
  });
  assert.deepEqual(fills.accepted, ["/last"]);
  assert.deepEqual(
    fills.issues.map((issue) => issue.code),
    ["cap-exceeded"],
  );
}

assert.equal(
  workspaceRootIssueSummary([
    { path: "/a/one", code: "missing", message: "Folder not found" },
    { path: "/a/two", code: "duplicate", message: "Already in this workspace" },
    { path: "/a/three", code: "missing", message: "Folder not found" },
    { path: "/a/four", code: "missing", message: "Folder not found" },
  ]),
  "one: Folder not found · two: Already in this workspace · three: Folder not found · 1 more",
);

// --- assessWorkspaceRoots ---------------------------------------------------

{
  const configured = ["/p", "/tmp/x", "/Volumes/USB/docs", "/private/tmp/x"];
  const health = assessWorkspaceRoots(configured, [
    ok("/p"),
    ok("/tmp/x", "/private/tmp/x"),
    gone("/Volumes/USB/docs"),
    ok("/private/tmp/x"),
  ]);
  assert.deepEqual(health.live, ["/p", "/tmp/x"]);
  assert.deepEqual(
    health.issues.map((issue) => [issue.path, issue.code]),
    [
      ["/Volumes/USB/docs", "missing"],
      ["/private/tmp/x", "duplicate"],
    ],
  );
  assert.equal(health.issues[1].message, "Already in this workspace");
  assert.equal(health.issues[1].relatedPath, "/tmp/x");
  assert.deepEqual(health.canonicalReplacements, {
    "/tmp/x": "/private/tmp/x",
  });

  // Before the first inspection lands every root stays usable.
  assert.deepEqual(assessWorkspaceRoots(configured, []).live, configured);

  // A missing primary is reported but never dropped, even when a preferred
  // primary leads the list.
  const preferred = assessWorkspaceRoots(
    ["/extra", "/p"],
    [ok("/extra"), gone("/p")],
    "/p",
  );
  assert.deepEqual(preferred.live, ["/extra", "/p"]);
  assert.equal(preferred.issues[0].code, "missing");
  assert.deepEqual(preferred.canonicalReplacements, {});
}

// --- one list normalizer ------------------------------------------------------

{
  const many = Array.from({ length: 30 }, (_, i) => `/f${i}/`);
  const list = normalizedWorkspaceFolderList("/p/", [
    "/p",
    ...many,
    "/f1",
    7,
    "",
  ]);
  assert.equal(list.length, MAX_WORKSPACE_FOLDERS - 1);
  assert.equal(list[0], "/f0");
  assert.ok(!list.includes("/p"));

  // The loader, the reducers, and workspaceFolderPaths agree.
  const loaded = createInitialWorkbenchState({
    preferences: {
      ...createInitialWorkbenchState().preferences,
      workspaceFolders: { "/p/": ["/p", ...many] },
    },
  });
  assert.deepEqual(loaded.preferences.workspaceFolders["/p"], list);
  let state = workbenchReducer(loaded, {
    type: "set-workspace-folders",
    workspacePath: "/p",
    paths: ["/p", ...many],
  });
  assert.deepEqual(state.preferences.workspaceFolders["/p"], list);
  assert.deepEqual(
    workspaceFolderPaths("/p", state.preferences.workspaceFolders),
    ["/p", ...list],
  );
}

// --- canonical storage and relocation ----------------------------------------

{
  let state = createInitialWorkbenchState();
  state = workbenchReducer(state, {
    type: "set-workspace-folders",
    workspacePath: "/p",
    paths: ["/tmp/x", "/private/tmp/x", "/Volumes/USB/docs"],
  });
  const before = state;
  state = workbenchReducer(state, {
    type: "canonicalize-workspace-folders",
    workspacePath: "/p",
    replacements: { "/tmp/x": "/private/tmp/x" },
  });
  assert.deepEqual(state.preferences.workspaceFolders["/p"], [
    "/private/tmp/x",
    "/Volumes/USB/docs",
  ]);
  assert.equal(
    workbenchReducer(state, {
      type: "canonicalize-workspace-folders",
      workspacePath: "/p",
      replacements: {},
    }),
    state,
    "a no-op canonicalization keeps the state object",
  );
  assert.notEqual(before, state);

  state = workbenchReducer(state, {
    type: "relocate-workspace-folder",
    workspacePath: "/p",
    from: "/Volumes/USB/docs",
    to: "/Users/me/docs",
  });
  assert.deepEqual(state.preferences.workspaceFolders["/p"], [
    "/private/tmp/x",
    "/Users/me/docs",
  ]);
}

{
  const preferences = {
    workspaceFolders: { "/old": ["/shared"], "/other": ["/z"] },
    projectDetails: {
      "/old": {
        name: "App",
        pinned: true,
        primaryFolder: "/old",
        allowNestedFolders: true,
      },
    },
    workspaceSettingsByWorkspace: { "/old": { searchMaxResults: 50 } },
    workspaceSettingsByFolder: { "/old": { editorMinimapEnabled: false } },
    workspaceTrust: { "/old": "trusted" },
  };
  const moved = relocateWorkspaceFolderPreferences(
    preferences,
    "/old",
    "/old",
    "/new",
  );
  assert.deepEqual(moved.workspaceFolders, {
    "/other": ["/z"],
    "/new": ["/shared"],
  });
  assert.deepEqual(moved.projectDetails["/new"], {
    name: "App",
    pinned: true,
    primaryFolder: "/new",
    allowNestedFolders: true,
  });
  assert.equal(moved.projectDetails["/old"], undefined);
  assert.deepEqual(moved.workspaceSettingsByWorkspace, {
    "/new": { searchMaxResults: 50 },
  });
  assert.deepEqual(moved.workspaceSettingsByFolder, {
    "/new": { editorMinimapEnabled: false },
  });
  assert.deepEqual(
    moved.workspaceTrust,
    { "/old": "trusted" },
    "trust is never carried over",
  );
  assert.equal(
    relocateWorkspaceFolderPreferences(preferences, "/old", "/old", "/old/"),
    preferences,
  );
}

// --- overlap opt-in persists ------------------------------------------------

{
  let state = workbenchReducer(createInitialWorkbenchState(), {
    type: "set-project-details",
    path: "/p",
    name: "P",
    pinned: false,
    allowNestedFolders: true,
  });
  assert.equal(state.preferences.projectDetails["/p"].allowNestedFolders, true);
  const reloaded = createInitialWorkbenchState({
    preferences: state.preferences,
  });
  assert.equal(
    reloaded.preferences.projectDetails["/p"].allowNestedFolders,
    true,
  );
  state = workbenchReducer(state, {
    type: "set-project-details",
    path: "/p",
    name: "P",
    pinned: false,
  });
  assert.equal(
    "allowNestedFolders" in state.preferences.projectDetails["/p"],
    false,
  );
}

// --- workspace files hand overflow to the validator ---------------------------

{
  const folders = Array.from({ length: 25 }, (_, i) => ({ path: `./f${i}` }));
  const parsed = parseGyroWorkspaceFile(
    JSON.stringify({ version: 1, folders }),
    "/ws/project.gyro-workspace.json",
  );
  assert.equal(parsed.folders.length, 25, "the parser no longer trims at 20");
  const result = validateWorkspaceRoots({
    existing: [ok(parsed.folders[0].path)],
    candidates: parsed.folders.slice(1).map((folder) => ok(folder.path)),
  });
  assert.equal(result.accepted.length, MAX_WORKSPACE_FOLDERS - 1);
  assert.equal(result.issues.length, 5);
  assert.ok(result.issues.every((issue) => issue.code === "cap-exceeded"));
}

// --- every add entry point goes through validation ----------------------------

const app = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const card = readFileSync(
  new URL("../packages/ui/src/sidebar-project-card.tsx", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL("../apps/desktop/src/use-workspace-roots.ts", import.meta.url),
  "utf8",
);
// Explorer add (button, palette, drop) and project settings call it in App;
// Locate… and workspace-file import call it from the hook module.
assert.equal(app.match(/admitWorkspaceFolders\(/g)?.length, 2);
assert.ok(app.includes("await admitWorkspaceFile("));
assert.ok(app.includes("useWorkspaceRootRecovery({"));
assert.ok(
  hook.match(/admitWorkspaceFolders\(/g)?.length >= 3,
  "Locate… and workspace-file import validate through the shared policy",
);
assert.ok(app.includes("useWorkspaceRootHealth("));
assert.ok(app.includes("workspaceRootIssues={workspaceRootIssues}"));
assert.ok(
  !app.includes("paths: persistedRoots.slice(1)"),
  "a backend identity echo must not overwrite configured roots",
);
assert.ok(card.includes("validateFolders(") && !card.includes(">= 19"));

console.log("workspace roots: ok");
