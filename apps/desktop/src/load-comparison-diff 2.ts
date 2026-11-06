import { invoke } from "@tauri-apps/api/core";
import type { ComparisonDiffResult } from "@gyro-dev/ui";

export async function loadGitComparisonDiff(
  workspacePath: string | undefined,
  file: { path: string; originalPath?: string; staged?: boolean },
  comparison: "working-tree" | "index" | "branch",
  isTauri: boolean,
): Promise<ComparisonDiffResult> {
  if (!workspacePath) {
    throw new Error("Open a workspace to inspect this change.");
  }
  if (!isTauri) {
    return {
      original: "",
      modified: `Preview of ${file.path}`,
      unified: `diff --git a/${file.path} b/${file.path}\n@@ Preview @@\n+Preview of ${file.path}`,
    };
  }
  const result = await invoke<ComparisonDiffResult>("git_review_content", {
    request: {
      workspacePath,
      path: file.path,
      originalPath: file.originalPath,
      staged: comparison === "index" || file.staged === true,
      comparison,
    },
  });
  if (result.notice && !result.unified && !result.original && !result.modified) {
    throw new Error(result.notice);
  }
  return result;
}
