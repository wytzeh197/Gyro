import type { ChatGridState } from "@gyro-dev/ui";

/** Resolve a delayed close against the pane that still owns the request. */
export function resolveChatPaneClose(
  grid: ChatGridState,
  candidate: { paneId: string; sessionId?: string },
) {
  const layout = Object.values(grid.layouts).find((entry) =>
    entry.slots.some(
      (pane) =>
        pane?.paneId === candidate.paneId &&
        (candidate.sessionId === undefined ||
          (pane.kind === "session" && pane.sessionId === candidate.sessionId)),
    ),
  );
  if (!layout) return undefined;
  const nextPane =
    layout.slots.find(
      (pane) =>
        pane?.paneId === layout.focusedPaneId &&
        pane?.paneId !== candidate.paneId,
    ) ?? layout.slots.find((pane) => pane && pane.paneId !== candidate.paneId);
  return {
    projectKey: layout.projectKey,
    isActiveProject: grid.activeProjectKey === layout.projectKey,
    nextPane,
  };
}
