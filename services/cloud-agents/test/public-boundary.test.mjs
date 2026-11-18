import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const code = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".toml",
  ".html",
]);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ["node_modules", "target", "dist", "build", ".git", ".wrangler"].includes(
        entry.name,
      ) ||
      entry.isSymbolicLink()
    )
      return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : code.has(extname(path))
        ? [path]
        : [];
  });
}
test("desktop, CLI and public packages cannot reference privileged Cloud credentials or import the Worker", () => {
  const violations = [];
  for (const directory of ["apps", "packages", "crates"]) {
    for (const path of files(join(root, directory))) {
      const source = readFileSync(path, "utf8");
      if (
        /SUPABASE_SERVICE_ROLE_KEY|CLOUD_AGENTS_ENCRYPTION_KEY|(?:from\s*|import\s*\()["'][^"']*services\/cloud-agents/.test(
          source,
        )
      )
        violations.push(path.slice(root.length));
    }
  }
  assert.deepEqual(
    violations,
    [],
    "privileged Cloud code must remain server-side",
  );
});
