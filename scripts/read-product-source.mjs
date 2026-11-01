// Source-contract tests follow extracted domains; architecture limits still
// read physical files directly. This helper changes no product runtime code.
import { readFileSync as readPhysicalFile } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const domains = new Map(
  [
    ["apps/desktop/src/App.tsx", "apps/desktop/src/app-state-helpers.tsx"],
    ["packages/ui/src/surfaces.tsx", "packages/ui/src/composer.tsx"],
    [
      "apps/desktop/src-tauri/src/lib.rs",
      "apps/desktop/src-tauri/src/lib_tests.rs",
    ],
    ["packages/ui/src/styles.css", "packages/ui/src/base-surfaces.css"],
  ].map(([entry, domain]) => [resolve(root, entry), resolve(root, domain)]),
);

export function readFileSync(file, options) {
  const content = readPhysicalFile(file, options);
  const path =
    file instanceof URL
      ? fileURLToPath(file)
      : typeof file === "string"
        ? resolve(file)
        : undefined;
  const domain = domains.get(path);
  if (!domain) return content;
  let extra = readPhysicalFile(domain, options);
  // Private helpers gained exports for the file boundary; source-contract VM
  // tests still exercise their bodies as the original local declarations.
  if (domain.endsWith("app-state-helpers.tsx") && typeof extra === "string") {
    extra = extra.replace(
      /^export (?=(?:async )?(?:function|const|let|type|interface)\b)/gm,
      "",
    );
  }
  return typeof content === "string"
    ? `${content}\n${extra}`
    : Buffer.concat([content, Buffer.from("\n"), extra]);
}

export async function readFile(file, options) {
  return readFileSync(file, options);
}
