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

export type GithubRefreshOptions = {
  force?: boolean;
  background?: "all" | "runs";
};

const AVAILABILITY_MAX_AGE_MS = 5 * 60_000;
export const GITHUB_ACTIVE_RUN_INTERVAL_MS = 15_000;
export const GITHUB_IDLE_INTERVAL_MS = 60_000;

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
  let inFlight:
    { promise: Promise<void>; runsOnly: boolean; loading: boolean } | undefined;
  let availabilityCache:
    { value: GithubAvailability; checkedAt: number } | undefined;
  let lastFullRefresh: number | undefined;
  let lastRunsRefresh: number | undefined;
  let runsError: string | undefined;
  let pullRequestsError: string | undefined;
  const requestGenerations = new Map<string, number>();

  function setWorkspace(root: string | undefined) {
    if (workspace === root) {
      return;
    }
    workspace = root;
    workspaceGeneration += 1;
    inFlight = undefined;
    availabilityCache = undefined;
    lastFullRefresh = undefined;
    lastRunsRefresh = undefined;
    runsError = undefined;
    pullRequestsError = undefined;
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

  async function performRefresh(
    root: string,
    options: GithubRefreshOptions,
    isCurrent: () => boolean,
  ) {
    const runsOnly = options.background === "runs";
    try {
      let availability = availabilityCache?.value;
      if (
        !runsOnly &&
        (!options.background ||
          !availability?.available ||
          Date.now() - (availabilityCache?.checkedAt ?? 0) >=
            AVAILABILITY_MAX_AGE_MS)
      ) {
        availability = await invoke<GithubAvailability>("github_status", {
          request: { workspacePath: root },
        });
        if (!isCurrent()) return;
        availabilityCache = { value: availability, checkedAt: Date.now() };
        dispatch({ type: "github-set-availability", availability });
      }
      if (!availability?.available) return;

      // Keep independent endpoint results and errors, including across a CI-only refresh.
      const [runs, pullRequests] = await Promise.allSettled([
        Promise.resolve().then(() =>
          invoke<GithubWorkflowRun[]>("github_workflow_runs", {
            request: { workspacePath: root, limit: 20 },
          }),
        ),
        runsOnly
          ? undefined
          : Promise.resolve().then(() =>
              invoke<GithubPullRequest[]>("github_pull_requests", {
                request: { workspacePath: root, limit: 20 },
              }),
            ),
      ]);
      if (!isCurrent()) {
        return;
      }
      if (runs.status === "fulfilled") {
        dispatch({ type: "github-set-runs", runs: runs.value });
        runsError = undefined;
      } else {
        runsError = `Workflow runs: ${errorMessage(runs.reason)}`;
      }
      if (pullRequests.status === "fulfilled" && pullRequests.value) {
        dispatch({
          type: "github-set-pull-requests",
          pullRequests: pullRequests.value,
        });
        pullRequestsError = undefined;
      } else if (pullRequests.status === "rejected") {
        pullRequestsError = `Pull requests: ${errorMessage(pullRequests.reason)}`;
      }
      const error = [runsError, pullRequestsError].filter(Boolean).join("\n");
      dispatch({ type: "github-error", error: error || undefined });
    } catch (error) {
      if (isCurrent()) {
        availabilityCache = undefined;
        dispatch({ type: "github-error", error: errorMessage(error) });
      }
    }
  }

  function refresh(
    root: string,
    options: GithubRefreshOptions = {},
  ): Promise<void> {
    const isCurrentWorkspace = captureWorkspace(root);
    if (!isCurrentWorkspace()) {
      return Promise.resolve();
    }
    const runsOnly = options.background === "runs";
    if (inFlight && !options.force) {
      if (!inFlight.runsOnly || runsOnly) {
        if (!options.background && !inFlight.loading) {
          inFlight.loading = true;
          dispatch({ type: "github-loading", loading: true });
        }
        return inFlight.promise;
      }
      return inFlight.promise.then(() =>
        isCurrentWorkspace() ? refresh(root, options) : undefined,
      );
    }
    const now = Date.now();
    if (
      runsOnly &&
      (!availabilityCache?.value.available ||
        (lastRunsRefresh !== undefined && now - lastRunsRefresh < 14_000))
    )
      return Promise.resolve();
    if (
      options.background === "all" &&
      lastFullRefresh !== undefined &&
      now - lastFullRefresh < 55_000
    )
      return Promise.resolve();
    if (!runsOnly) lastFullRefresh = now;
    lastRunsRefresh = now;
    // A completed mutation requires a read started after that mutation.
    // Superseded reads must not publish old data or finish the new spinner.
    const generation = ++refreshGeneration;
    const isCurrent = () =>
      isCurrentWorkspace() && refreshGeneration === generation;
    const loading = !options.background || Boolean(inFlight?.loading);
    if (!options.background)
      dispatch({ type: "github-error", error: undefined });
    if (loading) dispatch({ type: "github-loading", loading: true });
    const promise = performRefresh(root, options, isCurrent).finally(() => {
      if (inFlight?.promise === promise) {
        if (isCurrent() && inFlight.loading) {
          dispatch({ type: "github-loading", loading: false });
        }
        inFlight = undefined;
      }
    });
    inFlight = { promise, runsOnly, loading };
    return promise;
  }

  return { setWorkspace, refresh, captureWorkspace, beginRequest };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
