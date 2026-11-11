import type { GitReadState, SourceControlState, WorkspacePreparationProgress } from "./types";

export function gitSetupMessage(state?: GitReadState): string | undefined {
  if (state === "not-repository") return "Git isn’t set up for this folder.";
  if (state === "unavailable") return "Git is unavailable on this device. Install Git to use Source Control, then refresh.";
  return undefined;
}

export function hasOnlyGitWarnings(progress?: WorkspacePreparationProgress): boolean {
  return progress?.status === "degraded" &&
    progress.errors.length > 0 &&
    progress.errors.every((error) => error.phase === "git");
}

export function preparationStatusLabel(progress: WorkspacePreparationProgress): string {
  if (progress.gitRetrying) return "Checking Git";
  if (hasOnlyGitWarnings(progress)) return "Git warning";
  return progress.status === "degraded" ? "Warnings" : progress.status;
}

export function preparationMessage(progress: WorkspacePreparationProgress): string {
  if (progress.gitRetrying) return "Refreshing Git";
  if (hasOnlyGitWarnings(progress)) return "Workspace ready · Git needs attention";
  return progress.message;
}

type GitReadResult = {
  readState?: GitReadState;
  available: boolean;
  stale?: boolean;
  error?: string | null;
};

const normalizedRoot = (root: string) => root.replace(/\/+$/, "") || "/";

/** A transport failure must not erase this workspace's last-known changes. */
export function retainGitSnapshot(previous: SourceControlState, incoming: SourceControlState): SourceControlState {
  if (!incoming.available && incoming.error && !incoming.stale &&
      incoming.readState !== "not-repository" && incoming.readState !== "unavailable" &&
      previous.available && previous.workspacePath && incoming.workspacePath &&
      normalizedRoot(previous.workspacePath) === normalizedRoot(incoming.workspacePath)) {
    return { ...previous, workspacePath: incoming.workspacePath, readState: incoming.readState ?? "failed",
      stale: true, error: incoming.error };
  }
  return incoming;
}

/** Only the result of this run's read may settle its own warning. */
export function reconcileGitPreparation(
  progress: WorkspacePreparationProgress | undefined,
  request: { workspacePath: string; runId: string; check: "status" | "branches" },
  result: GitReadResult,
): WorkspacePreparationProgress | undefined {
  if (!progress || progress.status === "preparing" || progress.status === "failed" ||
      progress.runId !== request.runId ||
      normalizedRoot(progress.workspacePath) !== normalizedRoot(request.workspacePath)) {
    return progress;
  }
  const state = result.readState ??
    (result.available && !result.error ? "ready" : "failed");
  const healthy = !result.stale && !result.error &&
    (state === "ready" || state === "not-repository" || state === "unavailable");
  const errors = progress.errors.filter(
    (error) => !(error.phase === "git" && error.gitCheck === request.check),
  );
  if (!healthy) {
    errors.push({
      phase: "git",
      gitCheck: request.check,
      message: result.error || (request.check === "status"
        ? "Couldn’t refresh Git status."
        : "Couldn’t refresh Git branches."),
    });
  }
  return {
    ...progress,
    gitState: request.check === "status" ? state : progress.gitState,
    errors,
    status: errors.length ? "degraded" : "ready",
    message: errors.length ? "Workspace ready with warnings" : "Workspace ready",
  };
}
