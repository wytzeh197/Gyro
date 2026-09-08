export type TerminalDropEdge = "left" | "right" | "top" | "bottom";
export type TerminalSplitLayout = { ids: string[]; axis: "horizontal" | "vertical" };

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
