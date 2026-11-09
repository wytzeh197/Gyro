import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireUi = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { build } = createRequire(requireDesktop.resolve("vite"))("esbuild");
const compiled = await build({
  stdin: {
    contents: 'export { sidebarProjectGroups, sidebarDraftGroupKey } from "./packages/ui/src/workspace-sidebar.tsx";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "lucide-react"],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  requireUi, module, module.exports,
);
const { sidebarProjectGroups, sidebarDraftGroupKey } = module.exports;
const gyro = "/projects/Gyro";
const cloud = "/projects/gyro-cloud";
const sessions = [
  { id: "gyro-chat", workspacePath: gyro, updatedAt: "2026-01-01" },
  { id: "cloud-chat", workspacePath: cloud, updatedAt: "2026-01-02" },
];
const projects = [{ path: gyro, label: "Gyro" }, { path: cloud, label: "gyro-cloud" }];
const groups = sidebarProjectGroups(sessions, projects, cloud);
assert.deepEqual(groups.map(({ key, label, items }) => [key, label, items.map((item) => item.id)]), [
  [gyro, "Gyro", ["gyro-chat"]],
  [cloud, "gyro-cloud", ["cloud-chat"]],
]);
assert.equal(sidebarDraftGroupKey(cloud, gyro, projects), cloud);
const draft = (title, workspacePath = cloud) => ({
  id: `draft:${workspacePath}`, title, workspacePath,
});
const benchmark = "/Users/dev/Documents/gyro-luna-benchmark-2026-11-04";
const restoredDrafts = [draft("New chat", benchmark)];
const staleProjects = [...projects, { path: benchmark, label: "gyro-luna-benchmark-2026-11-04" }];
const restoredSnapshot = JSON.stringify(restoredDrafts);
assert.deepEqual(
  sidebarProjectGroups(sessions, staleProjects, gyro, restoredDrafts).map((group) => group.key),
  [gyro, cloud],
  "an inactive empty draft and remembered path must not resurrect a ghost project",
);
assert.deepEqual(
  sidebarProjectGroups(
    [...sessions, { id: "bench", workspacePath: benchmark, updatedAt: "2026-11-04" }],
    staleProjects,
    gyro,
    restoredDrafts,
  ).map((group) => group.key),
  [gyro, cloud],
  "a generated benchmark folder must not become a project even when it has a chat",
);
assert.deepEqual(
  sidebarProjectGroups(
    [{ id: "bench", workspacePath: benchmark, updatedAt: "2026-11-04" }],
    [],
    benchmark,
    [],
  ).map(({ key, hasWorkspace, items }) => [
    key,
    hasWorkspace,
    items.map((item) => item.id),
  ]),
  [[benchmark, true, ["bench"]]],
  "the open scratch folder stays reachable with its chat",
);
for (const title of ["New chat", " NEW MISSION ", "Desktop session", "Worktree session", "Agent workspace", "CLI workspace", ""]) {
  assert.deepEqual(
    sidebarProjectGroups([], projects, gyro, [draft(title)]).map((group) => group.key),
    [gyro],
    `a hidden draft must not leave an empty project group: ${JSON.stringify(title)}`,
  );
}
assert.deepEqual(
  sidebarProjectGroups([], staleProjects, undefined, restoredDrafts),
  [],
  "an empty workspace must not acquire a project from restored placeholders or saved paths",
);
assert.deepEqual(
  sidebarProjectGroups([], [], benchmark, restoredDrafts).map(({ key, items }) => [key, items]),
  [[benchmark, []]],
  "the explicitly active workspace remains visible before its first chat",
);
assert.equal(
  sidebarProjectGroups([], projects, gyro, [draft("Plan the release")]).find((group) => group.key === cloud)?.label,
  "gyro-cloud",
  "a visible named draft keeps its project navigable",
);
assert.equal(
  sidebarProjectGroups(sessions, staleProjects, gyro, [draft("New chat")]).find((group) => group.key === cloud)?.items[0].id,
  "cloud-chat",
  "a hidden draft must not hide a project with real chats",
);
assert.equal(JSON.stringify(restoredDrafts), restoredSnapshot, "grouping must preserve saved drafts");
console.log("Sidebar project grouping passed.");
