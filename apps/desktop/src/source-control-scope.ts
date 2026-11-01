import { useMemo } from "react";
import type { IdeState, SourceControlState } from "@gyro-dev/ui";

const EMPTY_SOURCE_CONTROL: SourceControlState = {
  provider: "git",
  available: false,
  ahead: 0,
  behind: 0,
  additions: 0,
  deletions: 0,
  statsPartial: false,
  files: [],
};

export function sourceControlForWorkspace(
  state: SourceControlState,
  workspacePath?: string,
): SourceControlState | undefined {
  if (
    typeof workspacePath !== "string" ||
    !workspacePath.trim() ||
    typeof state.workspacePath !== "string" ||
    !state.workspacePath.trim()
  )
    return undefined;
  // Spaces are meaningful directory-name characters; only a trailing slash
  // may differ from the exact path that produced the snapshot.
  const owner = state.workspacePath.replace(/\/+$/, "") || state.workspacePath;
  const requested = workspacePath.replace(/\/+$/, "") || workspacePath;
  return owner === requested ? state : undefined;
}

/** Shared IDE state may hold a late result or a previous root's snapshot. */
export function useScopedIdeState(ide: IdeState, workspacePath?: string) {
  const sourceControl =
    sourceControlForWorkspace(ide.sourceControl, workspacePath) ??
    EMPTY_SOURCE_CONTROL;
  return useMemo(
    () =>
      sourceControl === ide.sourceControl ? ide : { ...ide, sourceControl },
    [ide, sourceControl],
  );
}
