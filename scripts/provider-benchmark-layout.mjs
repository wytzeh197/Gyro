import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export async function createBenchmarkRoot(prefix, layout = null) {
  const temporaryDirectory = await realpath(tmpdir());
  const prospectiveRoot = join(temporaryDirectory, `${prefix}XXXXXX`);
  const socketPath = join(
    benchmarkStoreDirectory(prospectiveRoot, layout),
    "gyro-4294967295.sock",
  );
  // macOS includes the trailing NUL in its 104-byte Unix socket path limit.
  const parent =
    process.platform === "darwin" && Buffer.byteLength(socketPath) >= 104
      ? "/private/tmp"
      : temporaryDirectory;
  return realpath(await mkdtemp(join(parent, prefix)));
}
