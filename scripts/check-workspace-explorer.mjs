import assert from "node:assert/strict";
import { mergeExplorerDirectories } from "../apps/desktop/src/workspace-explorer.ts";
import {
  absoluteWorkspaceFilePath,
  workspaceCopyAbsolutePath,
  workspaceCopyRelativePath,
} from "../packages/ui/src/workspace-project.ts";
import {
  defaultWorkspaceUserSettings,
  normalizedWorkspaceUserSettings,
} from "../packages/ui/src/workspace-settings.ts";

const root = { path: "/project", kind: "directory", isWorkspaceRoot: true };
const dir = { path: "/project/src", kind: "directory" };
const entry = { path: "/project/src/app.ts", kind: "file" };
const listing = { path: dir.path, files: [entry] };
assert.deepEqual(mergeExplorerDirectories([root, dir], [listing]), [
  root,
  dir,
  entry,
]);
assert.deepEqual(
  mergeExplorerDirectories([root], [listing]),
  [root],
  "Deleted folders must not retain cached descendants",
);
assert.deepEqual(
  mergeExplorerDirectories([root, dir, entry], [{ path: dir.path, files: [] }]),
  [root, dir],
  "An empty response must remove deleted files",
);
const other = { ...root, path: "/other" };
assert.deepEqual(
  mergeExplorerDirectories([other], [listing]),
  [other],
  "Switching projects must not leak the old tree",
);
assert.deepEqual(
  mergeExplorerDirectories([root, dir, other], [listing]),
  [root, dir, entry, other],
  "Added workspace roots retain their order",
);
const rootEntries = [
  { path: "/project/.github", kind: "directory" },
  { path: "/project/.pnpm-store", kind: "directory" },
  { path: "/project/.wrangler", kind: "directory" },
  { path: "/project/node_modules", kind: "directory" },
  { path: "/project/target", kind: "directory" },
  { path: "/project/README.md", kind: "file" },
  { path: "/project/apps", kind: "directory" },
  { path: "/project/.env.example", kind: "file" },
  { path: "/project/src", kind: "directory" },
];
assert.deepEqual(
  mergeExplorerDirectories([root, ...rootEntries], []).map((file) => file.path),
  [
    "/project",
    "/project/apps",
    "/project/src",
    "/project/README.md",
    "/project/.github",
    "/project/.env.example",
    "/project/.pnpm-store",
    "/project/.wrangler",
    "/project/node_modules",
    "/project/target",
  ],
  "Root content should lead while configuration and generated paths remain visible",
);
const many = Array.from({ length: 1250 }, (_, i) => ({
  path: `/project/src/file-${i}.ts`,
  kind: "file",
}));
assert.equal(
  mergeExplorerDirectories([root, dir], [{ path: dir.path, files: many }])
    .length,
  1252,
);

const workspaceRoot = "/Users/wytze/Gyro";
const contributing = {
  path: `${workspaceRoot}/CONTRIBUTING.md`,
  workspacePath: workspaceRoot,
  relativePath: "CONTRIBUTING.md",
};
assert.equal(
  workspaceCopyAbsolutePath(contributing),
  contributing.path,
  "Copy Path uses the file, not the workspace root stored beside it",
);
assert.equal(
  workspaceCopyRelativePath(contributing),
  "CONTRIBUTING.md",
  "Copy Relative Path keeps the path inside the workspace",
);
assert.equal(
  workspaceCopyRelativePath({
    path: `${workspaceRoot}/docs/qa.md`,
    workspacePath: workspaceRoot,
    relativePath: "docs/qa.md",
  }),
  "docs/qa.md",
);
assert.equal(
  absoluteWorkspaceFilePath(workspaceRoot, contributing.path),
  contributing.path,
  "Reveal must not prefix the workspace root onto an absolute explorer path",
);
assert.equal(
  absoluteWorkspaceFilePath(workspaceRoot, "docs/qa.md"),
  `${workspaceRoot}/docs/qa.md`,
);

const legacy = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "target/**",
];
assert.deepEqual(
  normalizedWorkspaceUserSettings({ filesExclude: legacy }).filesExclude,
  [".git/**"],
);
const custom = [".git/**", "private/**"];
assert.deepEqual(
  normalizedWorkspaceUserSettings({ filesExclude: custom }).filesExclude,
  custom,
);
assert.deepEqual(
  defaultWorkspaceUserSettings.searchExclude,
  legacy,
  "Search exclusions should remain independent of Explorer visibility",
);
console.log(
  "Workspace Explorer checks passed: complete listings, root order, refresh, deletion, multiple roots, and exclusion migration.",
);
