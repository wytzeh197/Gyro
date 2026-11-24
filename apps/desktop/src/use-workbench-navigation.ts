import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, type Dispatch } from "react";
import {
  revealChatQuestion,
  type EditorRevealTarget,
  type ModelFocus,
  type ModelFocusPeekContent,
  type WorkbenchAction,
  type WorkbenchState,
  type WorkspaceFileContent,
} from "@gyro-dev/ui";
import {
  MODEL_FOCUS_PEEK_CONTEXT_LINES,
  workspaceName,
  type MenuBarNavigationTarget,
  type ProviderApprovalNotificationOpen,
} from "./app-state";
import { isTauriRuntime } from "./tauri-runtime";

type Options = {
  activeSessionIdRef: { readonly current: string | undefined };
  dispatchWorkbench: Dispatch<WorkbenchAction>;
  refreshEvents: (sessionId: string) => Promise<unknown>;
  selectSession: (sessionId: string) => void;
  setEditorRevealTarget: (target: EditorRevealTarget) => void;
  setSelectedFile: (path: string) => void;
  workbench: WorkbenchState;
  workspaceRoots: readonly string[];
};

export function useWorkbenchNavigation({
  activeSessionIdRef,
  dispatchWorkbench,
  refreshEvents,
  selectSession,
  setEditorRevealTarget,
  setSelectedFile,
  workbench,
  workspaceRoots,
}: Options) {
  /**
   * The one path that navigates on the model's behalf, and only because the
   * user clicked "Open in workspace" on the focus strip or its peek.
   */
  const openModelFocus = useCallback(
    (focus: ModelFocus) => {
      if (focus.sessionId !== activeSessionIdRef.current) {
        selectSession(focus.sessionId);
      }
      if (focus.kind === "ide" && focus.path) {
        setSelectedFile(focus.path);
        dispatchWorkbench({
          type: "ide-open-tab",
          tab: {
            path: focus.path,
            title: workspaceName(focus.path),
            dirty: false,
            preview: true,
          },
        });
        setEditorRevealTarget({
          path: focus.path,
          lineNumber: Math.max(1, focus.line ?? 1),
          column: Math.max(1, focus.column ?? 1),
          nonce: Date.now(),
        });
        dispatchWorkbench({ type: "select-workspace-layout", layout: "code" });
        return;
      }
      if (focus.kind === "terminal" && focus.paneId) {
        dispatchWorkbench({
          type: "select-terminal-pane",
          paneId: focus.paneId,
        });
      }
      if (focus.paneTab) {
        dispatchWorkbench({ type: "open-tool-panel", tab: focus.paneTab });
      }
    },
    [selectSession],
  );

  const loadModelFocusPeek = useCallback(
    async (focus: ModelFocus): Promise<ModelFocusPeekContent> => {
      if (focus.kind === "terminal") {
        const pane = workbench.terminalPanes.find(
          (item) => item.id === focus.paneId,
        );
        return {
          title: focus.detail ?? focus.label,
          subtitle: pane ? pane.status : "No terminal snapshot yet",
          lines: (pane?.output ?? "").split("\n").slice(-40),
        };
      }
      if (focus.kind === "output") {
        const channel = workbench.ide.outputChannels.find(
          (item) => item.id === focus.resourceId,
        );
        return {
          title: focus.label,
          subtitle: focus.detail,
          lines: (channel?.lines ?? [])
            .flatMap((line) => line.split("\n"))
            .slice(-40),
        };
      }
      if (focus.kind === "proposal") {
        return {
          title: focus.label,
          subtitle: `${workbench.diffReview.files.length} file(s) in review`,
          lines: workbench.diffReview.files.map(
            (file) => `${file.state.padEnd(9)} ${file.path}`,
          ),
        };
      }
      if (focus.kind === "browser") {
        return {
          title: focus.label,
          subtitle: focus.detail,
          lines: focus.detail ? [focus.detail] : [],
        };
      }
      const root = workspaceRoots[0];
      if (!focus.path || !root) {
        return { title: focus.label, lines: [] };
      }
      const content = await invoke<WorkspaceFileContent>(
        "read_workspace_file_full",
        { path: focus.path, workspacePath: root },
      );
      const allLines = content.content.split("\n");
      const target = Math.max(1, focus.line ?? 1);
      const startLine = Math.max(1, target - MODEL_FOCUS_PEEK_CONTEXT_LINES);
      return {
        title: focus.label,
        subtitle: focus.path,
        lines: allLines.slice(
          startLine - 1,
          target + MODEL_FOCUS_PEEK_CONTEXT_LINES,
        ),
        startLine,
        highlightLine: target,
      };
    },
    [
      workbench.diffReview.files,
      workbench.ide.outputChannels,
      workbench.terminalPanes,
      workspaceRoots,
    ],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let mounted = true;
    let unlistenNavigation: (() => void) | undefined;
    void listen<MenuBarNavigationTarget>(
      "gyro://menu-bar-navigation",
      (event) => {
        if (!mounted) return;
        const target = event.payload;
        if (target.kind === "chat") {
          dispatchWorkbench({
            type: "select-destination",
            destination: "workspace",
          });
          selectSession(target.id);
          const reveal = () =>
            requestAnimationFrame(() => revealChatQuestion(target.id));
          void refreshEvents(target.id).then(reveal, reveal);
          return;
        }
        if (target.kind === "automation") {
          dispatchWorkbench({
            type: "select-automation",
            automationId: target.id,
          });
          return;
        }
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        });
        dispatchWorkbench({
          type: "set-settings-section",
          section: "general",
        });
      },
    ).then((unlisten) => {
      if (!mounted) unlisten();
      else unlistenNavigation = unlisten;
    });
    return () => {
      mounted = false;
      unlistenNavigation?.();
    };
  }, [refreshEvents, selectSession]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let isMounted = true;
    let unlistenApprovalNotification: (() => void) | undefined;
    void listen<ProviderApprovalNotificationOpen>(
      "gyro://provider-approval-notification-open",
      (event) => {
        if (!isMounted || !event.payload.sessionId) return;
        dispatchWorkbench({
          type: "select-destination",
          destination: "workspace",
        });
        selectSession(event.payload.sessionId);
        void refreshEvents(event.payload.sessionId);
      },
    ).then((unlisten) => {
      if (!isMounted) {
        unlisten();
        return;
      }
      unlistenApprovalNotification = unlisten;
    });
    return () => {
      isMounted = false;
      unlistenApprovalNotification?.();
    };
  }, [refreshEvents, selectSession]);

  return { openModelFocus, loadModelFocusPeek };
}
