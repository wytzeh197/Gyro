import type {
  GithubAvailability,
  GithubPullRequest,
  GithubWorkflowRun,
  WorkbenchAction,
} from "@gyro-dev/ui";

type GithubRefreshDependencies = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  dispatch: (action: WorkbenchAction) => void;
};

/**
 * Coordinate repository reads independently of component renders. Workspace
 * changes invalidate every outstanding read, including a switch away and back.
 * This controller never retries GitHub mutations.
 */
export function createGithubRefreshController({
  invoke,
  dispatch,
}: GithubRefreshDependencies) {
  let workspace: string | undefined;
  let workspaceGeneration = 0;
  let refreshGeneration = 0;
  let inFlight: { promise: Promise<void> } | undefined;
  const requestGenerations = new Map<string, number>();

  function setWorkspace(root: string | undefined) {
    if (workspace === root) {
      return;
    }
    workspace = root;
    workspaceGeneration += 1;
    inFlight = undefined;
    requestGenerations.clear();
  }

  function captureWorkspace(root: string): () => boolean {
    const generation = workspaceGeneration;
    return () =>
      Boolean(root) && workspace === root && workspaceGeneration === generation;
  }

  /** A new request invalidates only earlier requests in the same channel. */
  function beginRequest(root: string, channel: string): () => boolean {
    const isCurrentWorkspace = captureWorkspace(root);
    if (!isCurrentWorkspace()) {
      return () => false;
    }
    const generation = (requestGenerations.get(channel) ?? 0) + 1;
    requestGenerations.set(channel, generation);
    return () =>
      isCurrentWorkspace() && requestGenerations.get(channel) === generation;
  }

  async function performRefresh(root: string, isCurrent: () => boolean) {
    dispatch({ type: "github-error", error: undefined });
    dispatch({ type: "github-loading", loading: true });
    try {
      const availability = await invoke<GithubAvailability>("github_status", {
        request: { workspacePath: root },
      });
      if (!isCurrent()) {
        return;
      }
      dispatch({ type: "github-set-availability", availability });
      if (!availability.available) {
        return;
      }

      // A denied PR endpoint must not hide healthy Actions data, or vice versa.
      // Promise callbacks also turn a synchronous adapter throw into a rejection.
      const [runs, pullRequests] = await Promise.allSettled([
        Promise.resolve().then(() =>
          invoke<GithubWorkflowRun[]>("github_workflow_runs", {
            request: { workspacePath: root, limit: 20 },
          }),
        ),
        Promise.resolve().then(() =>
          invoke<GithubPullRequest[]>("github_pull_requests", {
            request: { workspacePath: root, limit: 20 },
          }),
        ),
      ]);
      if (!isCurrent()) {
        return;
      }
      const errors: string[] = [];
      if (runs.status === "fulfilled") {
        dispatch({ type: "github-set-runs", runs: runs.value });
      } else {
        errors.push(`Workflow runs: ${errorMessage(runs.reason)}`);
      }
      if (pullRequests.status === "fulfilled") {
        dispatch({
          type: "github-set-pull-requests",
          pullRequests: pullRequests.value,
        });
      } else {
        errors.push(`Pull requests: ${errorMessage(pullRequests.reason)}`);
      }
      // Result actions may clear an earlier error, so publish failures last.
      dispatch({ type: "github-error", error: errors.join("\n") || undefined });
    } catch (error) {
      if (isCurrent()) {
        dispatch({ type: "github-error", error: errorMessage(error) });
      }
    } finally {
      if (isCurrent()) {
        dispatch({ type: "github-loading", loading: false });
      }
    }
  }

  function refresh(
    root: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const isCurrentWorkspace = captureWorkspace(root);
    if (!isCurrentWorkspace()) {
      return Promise.resolve();
    }
    if (inFlight && !options.force) {
      return inFlight.promise;
    }
    // A completed mutation requires a read started after that mutation.
    // Superseded reads must not publish old data or finish the new spinner.
    const generation = ++refreshGeneration;
    const isCurrent = () =>
      isCurrentWorkspace() && refreshGeneration === generation;
    const promise = performRefresh(root, isCurrent).finally(() => {
      if (inFlight?.promise === promise) {
        inFlight = undefined;
      }
    });
    inFlight = { promise };
    return promise;
  }

  return { setWorkspace, refresh, captureWorkspace, beginRequest };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
