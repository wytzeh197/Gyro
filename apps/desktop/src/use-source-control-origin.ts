import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ChatAttachment,
  EditorTab,
  Session,
  SessionEvent,
  WorkbenchAction,
} from "@gyro-dev/ui";
import { workspaceName } from "./app-state";
import { isPreviewSessionId } from "./session-creation";
import { mergeSessionHistoryPages } from "./session-event-order";
import {
  originHunkLabel,
  sessionHasOriginRoot,
  type OriginHistory,
  type OriginHunk,
  type OriginSource,
} from "./source-control-origin";

type Options = {
  activeSessionIdRef: { readonly current: string | undefined };
  capabilityResourceDataByCallId: OriginHistory["testResults"];
  dispatchWorkbench: Dispatch<WorkbenchAction>;
  selectSession: (sessionId: string) => void;
  sessionEventsByIdRef: { readonly current: Readonly<Record<string, SessionEvent[]>> };
  setChatAttachments: Dispatch<SetStateAction<Record<string, ChatAttachment[]>>>;
  setChatDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSelectedFile: (path: string) => void;
  setSelectedWorkspaceRoot: (path: string | undefined) => void;
  visibleSessions: readonly Session[];
};

export function useSourceControlOrigin({
  activeSessionIdRef,
  capabilityResourceDataByCallId,
  dispatchWorkbench,
  selectSession,
  sessionEventsByIdRef,
  setChatAttachments,
  setChatDrafts,
  setSelectedFile,
  setSelectedWorkspaceRoot,
  visibleSessions,
}: Options) {
  const [changeOriginNavigation, setChangeOriginNavigation] = useState<{
    sessionId: string;
    turnId: string;
    tab: EditorTab;
    hunk: OriginHunk;
    draft: boolean;
    returning: boolean;
  }>();
  const originSessionsRef = useRef(visibleSessions);
  originSessionsRef.current = visibleSessions;
  const selectOriginSessionRef = useRef(selectSession);
  selectOriginSessionRef.current = selectSession;
  const originTestResultsRef = useRef(capabilityResourceDataByCallId);
  originTestResultsRef.current = capabilityResourceDataByCallId;
  const readScmOriginHistory = useCallback(
    async (root: string, signal: AbortSignal): Promise<OriginHistory> => {
      const eligible = originSessionsRef.current
        .filter(
          (session) =>
            !session.importSource &&
            !isPreviewSessionId(session.id) &&
            sessionHasOriginRoot(session, root),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const limit = 10;
      const candidates = eligible.slice(0, limit);
      const active = eligible.find(
        (session) => session.id === activeSessionIdRef.current,
      );
      if (active && !candidates.includes(active))
        candidates[limit - 1] = active;
      const history: OriginHistory = {
        chats: [],
        limited: eligible.length > limit,
        failed: false,
      };
      // Bounded, user-triggered history reads. Use the same saved patches the
      // chat's Review surface uses, without opening or refreshing those chats.
      for (
        let start = 0;
        start < candidates.length && !signal.aborted;
        start += 3
      ) {
        const results = await Promise.allSettled(
          candidates.slice(start, start + 3).map(async (session) => ({
            session,
            page: await invoke<{
              events: SessionEvent[];
              hasMoreBefore: boolean;
            }>("read_session_events", { sessionId: session.id, limit: 200 }),
          })),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            history.failed = true;
            continue;
          }
          const { session, page } = result.value;
          history.limited ||= page.hasMoreBefore;
          history.chats.push({
            session,
            events: mergeSessionHistoryPages(
              sessionEventsByIdRef.current[session.id] ?? [],
              page.events,
            ),
          });
        }
      }
      return { ...history, testResults: originTestResultsRef.current };
    },
    [],
  );

  const openScmOriginChat = useCallback(
    async (
      tab: EditorTab,
      source: OriginSource,
      hunk: OriginHunk,
      draft: boolean,
      signal: AbortSignal,
    ) => {
      const review = tab.sourceControlDiff;
      const canOpen = () =>
        review &&
        originSessionsRef.current.some(
          (session) =>
            session.id === source.sessionId &&
            sessionHasOriginRoot(session, review.workspacePath),
        );
      if (signal.aborted) return;
      if (!review || !canOpen())
        throw new Error(
          "The source chat is no longer available in this workspace.",
        );
      if (draft) {
        const patch = `${hunk.header}\n${hunk.lines.join("\n")}\n`;
        const attachment = await invoke<ChatAttachment>(
          "prepare_chat_attachment",
          {
            request: {
              sessionId: source.sessionId,
              workspacePath: review.workspacePath,
              path: "",
              kind: "ide-snapshot",
              name: `${workspaceName(review.path).slice(0, 200)}.diff`,
              relativePath: review.path,
              bytes: Array.from(new TextEncoder().encode(patch)),
            },
          },
        );
        if (signal.aborted) return;
        if (!canOpen())
          throw new Error(
            "The source chat is no longer available in this workspace.",
          );
        setChatAttachments((current) => {
          const items = current[source.sessionId] ?? [];
          if (
            items.some(
              (item) =>
                (item.contentHash &&
                  item.contentHash === attachment.contentHash &&
                  item.relativePath === attachment.relativePath) ||
                item.id === attachment.id,
            )
          )
            return current;
          return { ...current, [source.sessionId]: [...items, attachment] };
        });
        setChatDrafts((current) =>
          current[source.sessionId]?.trim()
            ? current
            : {
                ...current,
                [source.sessionId]: `Can you explain the attached change in ${review.path} (${originHunkLabel(hunk).toLowerCase()})?`,
              },
        );
      }
      setChangeOriginNavigation({
        sessionId: source.sessionId,
        turnId: source.turnId,
        tab,
        hunk,
        draft,
        returning: false,
      });
      selectOriginSessionRef.current(source.sessionId);
    },
    [setChatDrafts],
  );

  const returnToOriginDiff = useCallback(() => {
    if (!changeOriginNavigation?.tab.sourceControlDiff) return;
    const { tab } = changeOriginNavigation;
    setChangeOriginNavigation({ ...changeOriginNavigation, returning: true });
    setSelectedWorkspaceRoot(tab.sourceControlDiff?.workspacePath);
    dispatchWorkbench({ type: "ide-select-view", view: "source-control" });
    dispatchWorkbench({ type: "ide-open-tab", tab });
    dispatchWorkbench({ type: "close-tool-panel" });
    setSelectedFile(tab.path);
  }, [changeOriginNavigation]);

  return {
    changeOriginNavigation,
    readScmOriginHistory,
    openScmOriginChat,
    returnToOriginDiff,
  };
}
