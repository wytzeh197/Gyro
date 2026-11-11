import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../packages/ui/src/", import.meta.url),
);

// Structural checks describe the UI contract, not its physical stylesheet.
// Foundation first keeps checks of the complete theme token block unambiguous.
export function readUiStyleSources() {
  return readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith(".css"))
    .sort((a, b) =>
      a === "styles-foundation.css"
        ? -1
        : b === "styles-foundation.css"
          ? 1
          : a.localeCompare(b),
    )
    .map((name) => ({
      path: `packages/ui/src/${name}`,
      source: readFileSync(resolve(directory, name), "utf8"),
    }));
}

export function readUiStyles() {
  return readUiStyleSources()
    .map(({ source }) => source)
    .join("\n");
}
