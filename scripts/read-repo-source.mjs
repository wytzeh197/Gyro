import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Structural guards inspect domain modules after extraction, while architecture
// limits continue to measure each physical file independently.
const companions = {
  "apps/desktop/src/App.tsx": ["app-state.tsx", "use-provider-capability-events.ts"],
  "packages/ui/src/surfaces.tsx": ["workspace-sidebar.tsx"],
  "packages/ui/src/styles.css": ["editor-navigation.css", "settings-layout.css", "chat.css", "chat-composer.css", "chat-companion.css"],
  "packages/ui/src/chat.css": ["chat-composer.css", "chat-companion.css"],
  "apps/desktop/src-tauri/src/lib.rs": ["tests.rs"],
};
export function readRepoSource(path, encoding = "utf8") {
  const filename = path instanceof URL ? fileURLToPath(path) : String(path);
  const related =
    Object.entries(companions).find(([suffix]) =>
      filename.endsWith(suffix),
    )?.[1] ?? [];
  return [
    readFileSync(filename, encoding),
    ...related.map((name) =>
      readFileSync(join(dirname(filename), name), encoding).replace(
        /^export /gm,
        "",
      ),
    ),
  ].join("\n");
}
