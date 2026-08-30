import type { ChatSidePanelId } from "./types.ts";

/**
 * The chat companion dock: one bordered column beside the transcript holding a
 * strip of tool tabs.
 *
 * Two rules shape everything below. There is at most one tab per tool, so
 * asking for a tool that is already open focuses it instead of stacking a
 * duplicate (Terminal still hosts several processes inside its one tab). And
 * the dock follows the focused chat pane: each pane keeps its own strip, so
 * moving between panes in the grid swaps which strip is on screen without
 * disturbing the one you left.
 */
export type ChatCompanionTabId = Extract<
  ChatSidePanelId,
  "review" | "terminal" | "browser" | "files" | "side-chat"
>;

export const chatCompanionTabIds: ChatCompanionTabId[] = [
  "review",
  "terminal",
  "browser",
  "files",
  "side-chat",
];

export const chatCompanionTabLabels: Record<ChatCompanionTabId, string> = {
  review: "Review",
  terminal: "Terminal",
  browser: "Browser",
  files: "Files",
  "side-chat": "Side chat",
};

export function isChatCompanionTabId(
  value?: string,
): value is ChatCompanionTabId {
  return chatCompanionTabIds.includes(value as ChatCompanionTabId);
}

export type ChatCompanionPaneState = {
  /** Tabs in strip order; the first opened sits leftmost. */
  openTabs: ChatCompanionTabId[];
  /** Undefined means the dock is closed for this pane. */
  activeTab?: ChatCompanionTabId;
  /**
   * Transient session backing the Side chat tab, when one is live. It is
   * created on open and destroyed on close, so it never reaches the sidebar,
   * the chat grid, or session history.
   */
  sideChatSessionId?: string;
};

export type ChatCompanionState = {
  focusedPaneId?: string;
  /** Shared across panes: the dock keeps one width as focus moves. */
  dockWidth: number;
  panes: Record<string, ChatCompanionPaneState>;
};

/** The transcript remains the primary work surface, even with a wide tool open. */
export const CHAT_COMPANION_MIN_WIDTH = 360;
export const CHAT_COMPANION_MAX_WIDTH = 720;
export const CHAT_COMPANION_DEFAULT_WIDTH = 520;
const CHAT_TRANSCRIPT_MIN_WIDTH = 480;

/**
 * Below this the dock would leave the transcript unreadable, so a pane narrower
 * than this falls back to Gyro's existing overlay presentation instead of
 * splitting. Tiled layouts hit this constantly.
 */
export const CHAT_COMPANION_OVERLAY_BELOW = 720;

export type ChatCompanionAction =
  | { type: "focus-pane"; paneId?: string }
  /** Opens the tool, or focuses it when the pane already has that tab. */
  | { type: "open-tab"; tab: ChatCompanionTabId; paneId?: string }
  | { type: "select-tab"; tab: ChatCompanionTabId; paneId?: string }
  | { type: "close-tab"; tab: ChatCompanionTabId; paneId?: string }
  /** Hides the dock without discarding the strip, so reopening restores it. */
  | { type: "close-dock"; paneId?: string }
  | { type: "reopen-dock"; paneId?: string }
  | { type: "resize-dock"; width: number }
  | { type: "bind-side-chat"; sessionId: string; paneId?: string }
  /** Drops a pane's strip outright — used when its chat pane closes. */
  | { type: "forget-pane"; paneId: string };

export const emptyChatCompanionPane: ChatCompanionPaneState = { openTabs: [] };

export function createInitialChatCompanionState(
  dockWidth = CHAT_COMPANION_DEFAULT_WIDTH,
): ChatCompanionState {
  return { dockWidth: clampChatCompanionWidth(dockWidth), panes: {} };
}

export function clampChatCompanionWidth(width: number, available?: number) {
  // A tool must never squeeze an active conversation into a narrow vertical
  // strip. The dock is secondary, so give the transcript a readable floor
  // before applying the dock's own bounds.
  const cap =
    available === undefined
      ? CHAT_COMPANION_MAX_WIDTH
      : Math.max(
          CHAT_COMPANION_MIN_WIDTH,
          Math.min(
            CHAT_COMPANION_MAX_WIDTH,
            available - CHAT_TRANSCRIPT_MIN_WIDTH,
          ),
        );
  if (!Number.isFinite(width)) {
    return Math.min(cap, CHAT_COMPANION_DEFAULT_WIDTH);
  }
  return Math.min(cap, Math.max(CHAT_COMPANION_MIN_WIDTH, Math.round(width)));
}

export function chatCompanionPane(
  state: ChatCompanionState,
  paneId?: string,
): ChatCompanionPaneState {
  const key = paneId ?? state.focusedPaneId;
  if (!key) return emptyChatCompanionPane;
  return state.panes[key] ?? emptyChatCompanionPane;
}

/** The tab the dock should render for a pane, or undefined when it is closed. */
export function activeChatCompanionTab(
  state: ChatCompanionState,
  paneId?: string,
): ChatCompanionTabId | undefined {
  return chatCompanionPane(state, paneId).activeTab;
}

/**
 * Which tab takes focus after `tab` is closed: the neighbour on its left, so
 * closing along the strip walks back toward the first tab rather than jumping.
 */
function neighbourTab(
  openTabs: ChatCompanionTabId[],
  closed: ChatCompanionTabId,
): ChatCompanionTabId | undefined {
  const index = openTabs.indexOf(closed);
  if (index < 0) return undefined;
  const remaining = openTabs.filter((tab) => tab !== closed);
  if (!remaining.length) return undefined;
  return remaining[Math.max(0, index - 1)];
}

export function chatCompanionReducer(
  state: ChatCompanionState,
  action: ChatCompanionAction,
): ChatCompanionState {
  if (action.type === "focus-pane") {
    if (state.focusedPaneId === action.paneId) return state;
    return { ...state, focusedPaneId: action.paneId };
  }
  if (action.type === "resize-dock") {
    const dockWidth = clampChatCompanionWidth(action.width);
    if (dockWidth === state.dockWidth) return state;
    return { ...state, dockWidth };
  }
  if (action.type === "forget-pane") {
    if (!(action.paneId in state.panes)) return state;
    const panes = { ...state.panes };
    delete panes[action.paneId];
    return {
      ...state,
      panes,
      focusedPaneId:
        state.focusedPaneId === action.paneId ? undefined : state.focusedPaneId,
    };
  }

  const paneId = action.paneId ?? state.focusedPaneId;
  if (!paneId) return state;
  const pane = state.panes[paneId] ?? emptyChatCompanionPane;
  const withPane = (next: ChatCompanionPaneState): ChatCompanionState => ({
    ...state,
    focusedPaneId: paneId,
    panes: { ...state.panes, [paneId]: next },
  });

  switch (action.type) {
    case "open-tab":
    case "select-tab": {
      const isOpen = pane.openTabs.includes(action.tab);
      if (isOpen && pane.activeTab === action.tab) return state;
      return withPane({
        ...pane,
        openTabs: isOpen ? pane.openTabs : [...pane.openTabs, action.tab],
        activeTab: action.tab,
      });
    }
    case "close-tab": {
      if (!pane.openTabs.includes(action.tab)) return state;
      const openTabs = pane.openTabs.filter((tab) => tab !== action.tab);
      const activeTab =
        pane.activeTab === action.tab
          ? neighbourTab(pane.openTabs, action.tab)
          : openTabs.length
            ? pane.activeTab
            : undefined;
      return withPane({
        ...pane,
        openTabs,
        activeTab,
        // Closing Side chat ends its transient session; the binding goes with
        // it so nothing later mistakes a dead id for a live one.
        sideChatSessionId:
          action.tab === "side-chat" ? undefined : pane.sideChatSessionId,
      });
    }
    case "close-dock": {
      if (pane.activeTab === undefined) return state;
      return withPane({ ...pane, activeTab: undefined });
    }
    case "reopen-dock": {
      if (pane.activeTab !== undefined) return state;
      const activeTab = pane.openTabs.at(-1);
      if (!activeTab) return state;
      return withPane({ ...pane, activeTab });
    }
    case "bind-side-chat":
      if (pane.sideChatSessionId === action.sessionId) return state;
      return withPane({ ...pane, sideChatSessionId: action.sessionId });
    default:
      return state;
  }
}

/**
 * Side-chat sessions that `next` no longer holds — closed tabs, closed panes,
 * rebindings. The caller deletes each one: the session, its events, its
 * attachments, and its provider binding.
 */
export function discardedSideChatSessionIds(
  previous: ChatCompanionState,
  next: ChatCompanionState,
): string[] {
  const live = new Set(
    Object.values(next.panes)
      .map((pane) => pane.sideChatSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  return [
    ...new Set(
      Object.values(previous.panes)
        .map((pane) => pane.sideChatSessionId)
        .filter((id): id is string => Boolean(id))
        .filter((id) => !live.has(id)),
    ),
  ];
}

/**
 * Side chats that outlived the process that created them. An unclean exit
 * leaves the session on disk with nothing pointing at it, so the next launch
 * sweeps every recorded id that no live dock still holds.
 */
export function staleSideChatSessionIds(
  recordedSessionIds: string[],
  state: ChatCompanionState,
): string[] {
  const live = new Set(
    Object.values(state.panes)
      .map((pane) => pane.sideChatSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  return [...new Set(recordedSessionIds)].filter((id) => !live.has(id));
}

/** Side chats are never listed alongside real sessions. */
export function withoutSideChatSessions<T extends { id: string }>(
  sessions: T[],
  sideChatSessionIds: Iterable<string>,
): T[] {
  const hidden = new Set(sideChatSessionIds);
  if (!hidden.size) return sessions;
  return sessions.filter((session) => !hidden.has(session.id));
}
