import { Edit3, Pin, Trash2 } from "lucide-react";
import { createContext, type ReactNode, useMemo } from "react";
import type { Session } from "./types";

/**
 * The sidebar's own chat-row actions, shared with the chat surfaces the app
 * chrome hosts. A chat's title menu offers Rename, Pin and Delete through the
 * same callbacks the sidebar uses, so there is one wiring for each action.
 * Surfaces rendered outside the chrome (fixtures, previews) read nothing and
 * keep a title menu of surfaces only.
 */
export type ChatSessionActions = {
  sessions: Session[];
  pinnedSessionIds: string[];
  sendingSessionIds: string[];
  onDeleteSession?: (sessionId: string) => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
};

export const ChatSessionActionsContext = createContext<
  ChatSessionActions | undefined
>(undefined);

export function ChatSessionActionsProvider({
  children,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  pinnedSessionIds,
  sendingSessionIds,
  sessions,
}: ChatSessionActions & { children: ReactNode }) {
  const value = useMemo<ChatSessionActions>(
    () => ({
      onDeleteSession,
      onPinSession,
      onRenameSession,
      pinnedSessionIds,
      sendingSessionIds,
      sessions,
    }),
    [
      onDeleteSession,
      onPinSession,
      onRenameSession,
      pinnedSessionIds,
      sendingSessionIds,
      sessions,
    ],
  );
  return (
    <ChatSessionActionsContext.Provider value={value}>
      {children}
    </ChatSessionActionsContext.Provider>
  );
}

/** What one chat's title menu can do with the chat itself. */
export type ChatTitleActions = {
  isPinned: boolean;
  /** A chat mid-turn cannot be deleted until its turn is stopped. */
  isWorking: boolean;
  label: string;
  onDelete?: () => void;
  onRename?: () => void;
  onTogglePin?: () => void;
};

/**
 * The actions for the chat a surface shows. A surface edits the draft keyed by
 * its session id, so an id that names no saved chat is an unsent draft, which
 * has nothing to rename, pin or delete yet.
 */
export function chatTitleActions(
  actions: ChatSessionActions | undefined,
  sessionId: string,
): ChatTitleActions | undefined {
  const session = actions?.sessions.find((item) => item.id === sessionId);
  if (!actions || !session) return undefined;
  const { onDeleteSession, onPinSession, onRenameSession } = actions;
  if (!onDeleteSession && !onPinSession && !onRenameSession) return undefined;
  return {
    isPinned: actions.pinnedSessionIds.includes(session.id),
    isWorking: actions.sendingSessionIds.includes(session.id),
    label: session.title?.trim() || "This chat",
    onDelete: onDeleteSession && (() => onDeleteSession(session.id)),
    onRename: onRenameSession && (() => onRenameSession(session.id)),
    onTogglePin: onPinSession && (() => onPinSession(session.id)),
  };
}

/**
 * The chat's own rows in the title's "More" menu, below its surfaces. Delete
 * sits apart and only asks: the caller owns the confirmation, because picking
 * any row closes this menu.
 */
export function ChatTitleActionItems({
  actions,
  hasItemsAbove,
  onClose,
  onRequestDelete,
}: {
  actions: ChatTitleActions;
  hasItemsAbove: boolean;
  onClose: () => void;
  onRequestDelete: () => void;
}) {
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <>
      {hasItemsAbove && (actions.onRename || actions.onTogglePin) ? (
        <div role="separator" />
      ) : null}
      {actions.onRename ? (
        <button onClick={run(actions.onRename)} role="menuitem" type="button">
          <Edit3 size={14} />
          <span>Rename chat</span>
        </button>
      ) : null}
      {actions.onTogglePin ? (
        <button
          onClick={run(actions.onTogglePin)}
          role="menuitem"
          type="button"
        >
          <Pin fill={actions.isPinned ? "currentColor" : "none"} size={14} />
          <span>{actions.isPinned ? "Unpin chat" : "Pin chat"}</span>
        </button>
      ) : null}
      {actions.onDelete ? (
        <>
          {hasItemsAbove || actions.onRename || actions.onTogglePin ? (
            <div role="separator" />
          ) : null}
          <button
            className="is-danger"
            onClick={run(onRequestDelete)}
            role="menuitem"
            type="button"
          >
            <Trash2 size={14} />
            <span>Delete chat</span>
          </button>
        </>
      ) : null}
    </>
  );
}
