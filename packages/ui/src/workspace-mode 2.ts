import type { WorkbenchMode } from "./types";

/**
 * Product language for session workspace modes.
 *
 * Storage and APIs stay on `local` | `worktree`. UI surfaces use these labels
 * so isolation reads as “agent’s own workspace” rather than Git jargon.
 */
export function workspaceModeLabel(mode: WorkbenchMode = "local"): string {
  return mode === "worktree" ? "Agent workspace" : "Project folder";
}

export function workspaceModeShortLabel(mode: WorkbenchMode = "local"): string {
  return mode === "worktree" ? "Isolated" : "Project";
}

export function workspaceModeDetail(
  mode: WorkbenchMode,
  options?: { hasWorkspace?: boolean },
): string {
  if (mode === "worktree") {
    return options?.hasWorkspace === false
      ? "Choose a Git repository first"
      : "Private branch; main folder stays untouched";
  }
  return "Edits apply in the project you opened";
}

export function workspaceModeToastTitle(mode: WorkbenchMode): string {
  return mode === "worktree" ? "Agent workspace" : "Project folder";
}

export function workspaceModeToastDetail(mode: WorkbenchMode): string {
  return mode === "worktree"
    ? "New runs get a private branch. Your main project stays untouched."
    : "New runs use the current workspace branch.";
}

export function workspaceModePopoverLabel(mode: WorkbenchMode): string {
  // Match the composer chip labels so the menu reads as two clear modes.
  return mode === "worktree" ? "Agent workspace" : "Project folder";
}

/** Technical term kept for tooltips and secondary detail only. */
export function workspaceModeTechnicalHint(mode: WorkbenchMode): string {
  return mode === "worktree"
    ? "Creates an isolated Git worktree under Gyro Application Support"
    : "Edits apply in the selected project checkout";
}
