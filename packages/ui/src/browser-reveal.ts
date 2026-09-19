/**
 * Whether a browser navigation should take a surface, or happen behind the chat.
 *
 * Gyro's browser is a native child webview, so "the model is browsing" and "the
 * user is looking at the browser" are separate facts. They used to be welded
 * together: every model navigation revealed the Browser panel, which in a split
 * layout meant one chat's tool call covered the transcript of the pane the user
 * was reading. The model does not need the panel — it reads the page through
 * the agent bridge, and the backend gives an unrevealed browser a full desktop
 * viewport — so revealing is purely a question about the person watching.
 */
export type BrowserRevealRequest = {
  /**
   * The user asked for this navigation: clicked a preview, opened a URL, chose
   * "show" on a tool call. Their own action always wins.
   */
  isUserInitiated: boolean;
  /** Two or more chat panes are tiled, so any panel covers a live transcript. */
  isSplitView: boolean;
  /** The Browser surface is already up, so there is nothing to reveal. */
  isBrowserVisible: boolean;
};

export type BrowserRevealReason =
  "user-initiated" | "already-visible" | "split-view-background" | "reveal";

export type BrowserRevealDecision = {
  reveal: boolean;
  reason: BrowserRevealReason;
};

/**
 * A single chat still reveals: with one transcript and a free rail, watching
 * the page the model is reading is the point. A split does not, because the
 * width it would take belongs to a conversation the user chose to keep open.
 */
export function resolveBrowserReveal(
  request: BrowserRevealRequest,
): BrowserRevealDecision {
  if (request.isUserInitiated) {
    return { reveal: true, reason: "user-initiated" };
  }
  if (request.isBrowserVisible) {
    return { reveal: false, reason: "already-visible" };
  }
  if (request.isSplitView) {
    return { reveal: false, reason: "split-view-background" };
  }
  return { reveal: true, reason: "reveal" };
}

/**
 * Whether a chat layout counts as split for this decision.
 *
 * Maximizing a pane gives that chat the whole grid back, so it is a single
 * chat again and reveals like one. This mirrors how the grid itself decides a
 * pane is tiled.
 */
export function isSplitChatLayout(options: {
  occupiedPaneCount: number;
  hasMaximizedPane: boolean;
}) {
  return options.occupiedPaneCount > 1 && !options.hasMaximizedPane;
}
