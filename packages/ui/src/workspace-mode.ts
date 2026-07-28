import type { WorkbenchMode } from "./types";

/**
 * Product language for session workspace modes.
 *
 * Storage and APIs stay on `local` | `worktree`. UI surfaces use these labels
 * so isolation reads as “agent’s own workspace” rather than Git jargon.
 */
export function workspaceModeLabel(mode: WorkbenchMode = "local"): string {
  return mode === "worktree" ? "Agent workspace" : "Shared folder";
}

export function workspaceModeShortLabel(mode: WorkbenchMode = "local"): string {
  return mode === "worktree" ? "Isolated" : "Shared";
}

export function workspaceModeDetail(
  mode: WorkbenchMode,
  options?: { hasWorkspace?: boolean },
): string {
  if (mode === "worktree") {
    return options?.hasWorkspace === false
      ? "Choose a Git repository first"
      : "Private branch under Gyro; your main folder stays untouched";
  }
  return "Agent works in the project folder you opened";
}

export function workspaceModeToastTitle(mode: WorkbenchMode): string {
  return mode === "worktree" ? "Agent workspace" : "Shared folder";
}

export function workspaceModeToastDetail(mode: WorkbenchMode): string {
  return mode === "worktree"
    ? "New runs get a private branch. Your main project stays untouched."
    : "New runs use the current workspace branch.";
}

export function workspaceModePopoverLabel(mode: WorkbenchMode): string {
  return mode === "worktree" ? "Use agent workspace" : "Work in shared folder";
}

/** Technical term kept for tooltips and secondary detail only. */
export function workspaceModeTechnicalHint(mode: WorkbenchMode): string {
  return mode === "worktree"
    ? "Creates an isolated Git worktree under Gyro Application Support"
    : "Edits apply in the selected project checkout";
}
