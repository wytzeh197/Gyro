export type TerminalDropEdge = "left" | "right" | "top" | "bottom";
export type TerminalSplitLayout = {
  ids: string[];
  axis: "horizontal" | "vertical";
};

/**
 * The minimum a pane has to expose to be classified for a terminal list.
 * Structural on purpose: the UI can hand in its full `TerminalPane` and keep
 * its own type, without this module importing the whole type surface.
 */
export type ListableTerminalPane = {
  id: string;
  owner?: { kind: string };
};

/**
 * The panes a terminal surface lists.
 *
 * A model-owned pane belongs to its chat, not to the set of terminals the user
 * manages: a background chat terminal must not crowd that strip or take the
 * selection from a task the user just started. One appears only while it is
 * the selected pane — an explicit "Open in workspace" from the focus strip, or
 * Follow mode — so it can still be watched and closed when asked for by name.
 */
export function listedTerminalPanes<Pane extends ListableTerminalPane>(
  panes: readonly Pane[] | undefined,
  selectedTerminalPaneId: string | undefined,
): Pane[] {
  return (panes ?? []).filter(
    (pane) =>
      pane.owner?.kind !== "model" || pane.id === selectedTerminalPaneId,
  );
}

/** Move an existing terminal into a split without duplicating or restarting it. */
export function placeTerminalTab(
  layout: TerminalSplitLayout,
  activeId: string,
  draggedId: string,
  edge: TerminalDropEdge,
): TerminalSplitLayout {
  const current = layout.ids.includes(activeId) ? layout.ids : [activeId];
  const ids = current.filter((id) => id !== draggedId);
  if (ids.length >= 4) return layout;
  if (edge === "left" || edge === "top") ids.unshift(draggedId);
  else ids.push(draggedId);
  return {
    ids,
    axis: edge === "top" || edge === "bottom" ? "vertical" : "horizontal",
  };
}
