import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Fixture repositories must be outside the app's private data directory.
export const isolatedBenchmarkLayout = {
  schema: "gyro.benchmark-layout.v1",
  storeDirectory: "data",
  workspacesDirectory: "workspaces",
};

export async function readBenchmarkLayout(root) {
  let text;
  try {
    text = await readFile(join(root, "layout.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const layout = JSON.parse(text);
  if (
    layout.schema !== isolatedBenchmarkLayout.schema ||
    layout.storeDirectory !== "data" ||
    layout.workspacesDirectory !== "workspaces"
  )
    throw new Error("Unsupported benchmark layout");
  return layout;
}

export function benchmarkStoreDirectory(root, layout) {
  return layout ? join(root, "data") : root;
}
