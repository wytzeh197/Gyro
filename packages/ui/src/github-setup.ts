import type { GithubAvailability, SourceControlState } from "./types";

/** A one-click step that runs in a Gyro terminal to get GitHub working. */
export type GithubSetupAction = "install" | "connect" | "publish" | "switch";

export type GithubSetupStep = {
  action: Exclude<GithubSetupAction, "switch">;
  title?: string;
  detail: string;
  label: string;
  command?: string;
  /** Leave undefined until the workspace's commit state is known. */
  hasCommits?: boolean;
};

// `gh repo view` says this for a folder with no remote at all, and for one
// that is not a Git repository yet. Both can be published from scratch; a
// folder whose remote points somewhere else (GitLab, a server) cannot.
const PUBLISHABLE = /no git remotes|not a git repository/i;

/**
 * The next thing standing between this workspace and GitHub, or nothing when
 * it is connected or the problem is not one a button can fix (a timeout, a
 * remote on another host).
 */
export function githubSetupStep(
  availability: GithubAvailability | undefined,
  sourceControl?: SourceControlState,
): GithubSetupStep | undefined {
  if (!availability || availability.available) return undefined;
  if (!availability.cliInstalled) {
    return {
      action: "install",
      title: "Install the GitHub CLI",
      detail:
        "Gyro uses GitHub's own command-line tool for pull requests, checks and pushes.",
      label: "Install GitHub CLI",
      command: "brew install gh",
    };
  }
  if (!availability.authenticated) {
    return {
      action: "connect",
      title: "Connect your GitHub account",
      detail:
        "Sign in once in your browser. Git pushes from Gyro and your terminal use the same login.",
      label: "Connect GitHub",
      command: "gh auth login --web",
    };
  }
  if (PUBLISHABLE.test(availability.error ?? "")) {
    const hasCommits = sourceControl?.stale
      ? undefined
      : sourceControl?.readState === "not-repository"
        ? false
        : sourceControl?.available &&
            sourceControl.detailsLoaded &&
            !sourceControl.error &&
            !sourceControl.historyError &&
            sourceControl.history
          ? sourceControl.history.length > 0
          : undefined;
    return {
      action: "publish",
      detail:
        hasCommits === false
          ? "Create an empty private repo."
          : hasCommits
            ? "Create a private repo and push local commits. Uncommitted files stay on this Mac."
            : "Create a private repo and push any local commits. Uncommitted files stay on this Mac.",
      label:
        hasCommits === false
          ? "Create repo"
          : hasCommits
            ? "Create & push"
            : "Publish to GitHub",
      command:
        hasCommits === undefined
          ? undefined
          : `gh repo create --private --source . --remote origin${hasCommits ? " --push" : ""}`,
      hasCommits,
    };
  }
  return undefined;
}
