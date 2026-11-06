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
assert.equal(sidebarProjectGroups([], projects, gyro, [{ workspacePath: cloud }]).find((group) => group.key === cloud)?.label, "gyro-cloud");
console.log("Sidebar project grouping passed.");
