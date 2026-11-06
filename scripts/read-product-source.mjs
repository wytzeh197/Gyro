// Source-contract tests follow extracted domains; architecture limits still
// read physical files directly. This helper changes no product runtime code.
import { readFileSync as readPhysicalFile } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const domains = new Map(
  [
    ["apps/desktop/src/App.tsx", ["apps/desktop/src/app-state.tsx"]],
    ["packages/ui/src/surfaces.tsx", ["packages/ui/src/workspace-sidebar.tsx"]],
    ["apps/desktop/src-tauri/src/lib.rs", ["apps/desktop/src-tauri/src/tests.rs"]],
    ["packages/ui/src/styles.css", ["packages/ui/src/settings-polish.css"]],
  ].map(([entry, companions]) => [resolve(root, entry), companions.map((file) => resolve(root, file))]),
);

export function readFileSync(file, options) {
  const content = readPhysicalFile(file, options);
  const path =
    file instanceof URL
      ? fileURLToPath(file)
      : typeof file === "string"
        ? resolve(file)
        : undefined;
  const companions = domains.get(path);
  if (!companions) return content;
  const extras = companions.map((domain) => {
    const extra = readPhysicalFile(domain, options);
    return typeof extra === "string" ? extra.replace(/^export /gm, "") : extra;
  });
  return typeof content === "string"
    ? [content, ...extras].join("\n")
    : Buffer.concat([content, ...extras.flatMap((extra) => [Buffer.from("\n"), extra])]);
}

export async function readFile(file, options) {
  return readFileSync(file, options);
}
