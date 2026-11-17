import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CapabilityActivity,
  ChatBrowserResource,
  EditorRevealTarget,
  ModelFocus,
  ModelFollowMode,
  Session,
  SessionEvent,
  TerminalPane,
  WorkbenchAction,
} from "@gyro-dev/ui";
import {
  capabilityActivityFromSessionEvent,
  ideAiToolCallFromActivity,
  terminalPaneFromSnapshot,
  terminalSnapshotFromCapabilityData,
  workspaceName,
  type ProviderCapabilityResourceEvent,
} from "./app-state";
import {
  numberFromUnknown,
  recordFromUnknown,
  stringFromRecord,
} from "./session-context-events";
import {
  retainChatResourcePayload,
  type ChatResourcePayload,
} from "./chat-session-updates";
import {
  limitSessionEventsForUi,
  limitOptimisticSessionEvents,
  mergeLiveCapabilityEvent,
} from "./provider-stream-events";
import { isTauriRuntime } from "./tauri-runtime";

type StateSetter<T> = Dispatch<SetStateAction<T>>;
type Bindings = {
  flushProviderStreamBatches: () => void;
  optimisticEventsRef: MutableRefObject<Map<string, SessionEvent[]>>;
  setEventsForSession: (
    sessionId: string,
    value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
  ) => void;
  setCapabilityRunsBySessionId: StateSetter<
    Record<string, Record<string, CapabilityActivity>>
  >;
  dispatchWorkbench: Dispatch<WorkbenchAction>;
  liveCapabilityResourceIdsRef: MutableRefObject<Set<string>>;
  setCapabilityResourceDataByCallId: StateSetter<
    Record<string, ChatResourcePayload>
  >;
  activeSessionIdRef: MutableRefObject<string | undefined>;
  modelFollowRef: MutableRefObject<ModelFollowMode>;
  terminalPanesRef: MutableRefObject<TerminalPane[]>;
  terminalOutputRevisionRef: MutableRefObject<Record<string, number>>;
  sessionsRef: MutableRefObject<Session[]>;
  setBrowserResourcesBySessionId: StateSetter<
    Record<string, ChatBrowserResource>
  >;
  isSplitChatViewRef: MutableRefObject<boolean>;
  setEditorRevealTarget: StateSetter<EditorRevealTarget | undefined>;
  setSelectedFile: StateSetter<string | undefined>;
  openWorkspaceFolderRef: MutableRefObject<
    ((path: string) => Promise<void>) | undefined
  >;
};

/** Stable subscriptions read current chat/follow state through refs. */
export function useProviderCapabilityEvents({
  flushProviderStreamBatches,
  optimisticEventsRef,
  setEventsForSession,
  setCapabilityRunsBySessionId,
  dispatchWorkbench,
  liveCapabilityResourceIdsRef,
  setCapabilityResourceDataByCallId,
  activeSessionIdRef,
  modelFollowRef,
  terminalPanesRef,
  terminalOutputRevisionRef,
  sessionsRef,
  setBrowserResourcesBySessionId,
  isSplitChatViewRef,
  setEditorRevealTarget,
  setSelectedFile,
  openWorkspaceFolderRef,
}: Bindings) {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let isMounted = true;
    let unlistenCapability: (() => void) | undefined;
    let unlistenResource: (() => void) | undefined;
    void listen<SessionEvent>("gyro://provider-capability-event", (event) => {
      if (!isMounted) return;
      // Paint earlier narration before placing a call from the separate
      // capability channel, just as we do for provider activity frames.
      flushProviderStreamBatches();
      const capabilityEvent = event.payload;
      const mergeEvent = (items: SessionEvent[]) =>
        limitSessionEventsForUi(
          mergeLiveCapabilityEvent(items, capabilityEvent),
        );
      optimisticEventsRef.current.set(
        capabilityEvent.sessionId,
        limitOptimisticSessionEvents(
          mergeEvent(
            optimisticEventsRef.current.get(capabilityEvent.sessionId) ?? [],
          ),
        ),
      );
      setEventsForSession(capabilityEvent.sessionId, (current) =>
        mergeEvent(current),
      );
      const activity = capabilityActivityFromSessionEvent(capabilityEvent);
      if (activity) {
        setCapabilityRunsBySessionId((current) => ({
          ...current,
          [activity.sessionId]: {
            ...(current[activity.sessionId] ?? {}),
            [activity.callId]: activity,
          },
        }));
        // Mirror the call into the Workspace AI view so tool use is visible
        // where the work is happening, without switching the sidebar to it.
        dispatchWorkbench({
          type: "ide-record-ai-tool-call",
          toolCall: ideAiToolCallFromActivity(activity),
        });
      }
    }).then((unlisten) => {
      if (!isMounted) unlisten();
      else unlistenCapability = unlisten;
    });
    void listen<ProviderCapabilityResourceEvent>(
      "gyro://provider-capability-resource",
      (event) => {
        if (!isMounted) return;
        const payload = event.payload;
        liveCapabilityResourceIdsRef.current.add(payload.resource.id);
        setCapabilityResourceDataByCallId((current) =>
          retainChatResourcePayload(
            current,
            payload.callId,
            payload.sessionId,
            payload.data,
          ),
        );
        const isActiveModelWorkspace =
          activeSessionIdRef.current === payload.sessionId;
        // The model reports where it is working; only "follow" lets that
        // report move the user. Everything else populates state in place and
        // surfaces it through the ambient strip and badges.
        const shouldFollow =
          isActiveModelWorkspace && modelFollowRef.current === "follow";
        const recordFocus = (
          focus: Omit<ModelFocus, "sessionId" | "callId" | "updatedAt">,
        ) => {
          dispatchWorkbench({
            type: "set-model-focus",
            focus: {
              ...focus,
              sessionId: payload.sessionId,
              callId: payload.callId,
              updatedAt: new Date().toISOString(),
            },
          });
        };
        if (payload.resource.kind === "terminal") {
          const snapshot = terminalSnapshotFromCapabilityData(payload.data);
          recordFocus({
            kind: "terminal",
            label: payload.resource.label,
            detail: snapshot?.command,
            paneTab: "terminal",
            paneId: snapshot?.paneId,
            resourceId: payload.resource.id,
          });
          if (snapshot) {
            const pane = terminalPaneFromSnapshot(snapshot, "local");
            dispatchWorkbench({
              type: "upsert-background-terminal-pane",
              pane: {
                ...pane,
                owner: {
                  kind: "model",
                  sessionId: payload.sessionId,
                  turnId: payload.turnId,
                  callId: payload.callId,
                },
              },
            });
            // Follow is the one mode where the app moves with the model, and
            // only for the chat on screen. Selecting the pane is what makes
            // the model's terminal join the strip; nothing else does, so the
            // user's own terminals stay uncluttered.
            if (shouldFollow) {
              dispatchWorkbench({
                type: "select-terminal-pane",
                paneId: snapshot.paneId,
              });
              dispatchWorkbench({ type: "open-tool-panel", tab: "terminal" });
            }
            terminalOutputRevisionRef.current[snapshot.paneId] =
              snapshot.outputRevision;
            const stoppedBy = stringFromRecord(
              recordFromUnknown(payload.data),
              "stoppedBy",
            );
            if (stoppedBy === "model") {
              const existing = terminalPanesRef.current.find(
                (item) => item.id === snapshot.paneId,
              );
              if (existing?.keepAlive) {
                dispatchWorkbench({
                  type: "set-terminal-pane-keep-alive",
                  paneId: snapshot.paneId,
                  keepAlive: {
                    ...existing.keepAlive,
                    phase: "stopped",
                    stopOrigin: "model",
                  },
                });
              }
            }
          }
        }
        if (payload.resource.kind === "browser") {
          const data = recordFromUnknown(payload.data);
          const capture = recordFromUnknown(data?.capture);
          const session = sessionsRef.current.find(
            (item) => item.id === payload.sessionId,
          );
          const url = stringFromRecord(data, "url") ?? payload.resource.label;
          const capturePath = stringFromRecord(capture, "path");
          recordFocus({
            kind: "browser",
            label: payload.resource.label,
            detail: url,
            paneTab: "browser",
          });
          if (session && url) {
            setBrowserResourcesBySessionId((current) => ({
              ...current,
              [payload.sessionId]: {
                id: payload.resource.id,
                sessionId: payload.sessionId,
                projectPath: session.workspacePath,
                url,
                status: "completed",
                label: payload.resource.label,
                latestCapturePath: capturePath,
              },
            }));
          }
          // Surface agent screenshots in the Live/Capture toggle + preview card.
          if (capturePath) {
            const width = numberFromUnknown(capture?.width) ?? 0;
            const height = numberFromUnknown(capture?.height) ?? 0;
            const filename =
              stringFromRecord(capture, "filename") ??
              capturePath.split(/[/\\]/).pop() ??
              "browser-capture.png";
            dispatchWorkbench({
              type: "browser-session",
              sessionId: payload.sessionId,
              action: {
                type: "browser-capture-success",
                capture: {
                  path: capturePath,
                  filename,
                  width,
                  height,
                  createdAt:
                    stringFromRecord(capture, "createdAt") ??
                    new Date().toISOString(),
                  src: isTauriRuntime()
                    ? convertFileSrc(capturePath)
                    : capturePath,
                  sourceUrl: url,
                },
              },
            });
          }
        }
        if (payload.resource.kind === "ide") {
          const data = recordFromUnknown(payload.data);
          const panel = stringFromRecord(data, "panel");
          if (
            panel === "diff" ||
            panel === "terminal" ||
            panel === "browser" ||
            panel === "problems" ||
            panel === "test-results" ||
            panel === "output"
          ) {
            recordFocus({
              kind: "ide",
              label: payload.resource.label,
              paneTab: panel,
            });
            if (
              shouldFollow &&
              !(panel === "browser" && isSplitChatViewRef.current)
            ) {
              dispatchWorkbench({ type: "open-tool-panel", tab: panel });
            }
          } else {
            const path = stringFromRecord(data, "path");
            if (path) {
              const line = typeof data?.line === "number" ? data.line : 1;
              const column = typeof data?.column === "number" ? data.column : 1;
              recordFocus({
                kind: "ide",
                label: workspaceName(path),
                detail: path,
                path,
                line: Math.max(1, line),
                column: Math.max(1, column),
              });
              // File access stays in the background unless the user explicitly
              // enables Follow model for the active session.
              if (shouldFollow) {
                dispatchWorkbench({
                  type: "ide-open-tab",
                  tab: {
                    path,
                    title: workspaceName(path),
                    dirty: false,
                    preview: true,
                  },
                });
                setEditorRevealTarget({
                  path,
                  lineNumber: Math.max(1, line),
                  column: Math.max(1, column),
                  nonce: Date.now(),
                });
                setSelectedFile(path);
                dispatchWorkbench({
                  type: "select-workspace-layout",
                  layout: "code",
                });
              }
            }
          }
        }
        if (payload.resource.kind === "output") {
          const data = recordFromUnknown(payload.data);
          const kind = stringFromRecord(data, "kind");
          const paneTab = kind === "test" ? "test-results" : "output";
          recordFocus({
            kind: "output",
            label: payload.resource.label,
            detail: kind === "test" ? "Tests" : "Task output",
            paneTab,
            resourceId: payload.resource.id,
          });
          if (isActiveModelWorkspace) {
            dispatchWorkbench({
              type: "ide-upsert-output-channel",
              channel: {
                id: payload.resource.id,
                label: payload.resource.label,
                kind: kind === "test" ? "test" : "task",
                lines: [
                  stringFromRecord(data, "stdout"),
                  stringFromRecord(data, "stderr"),
                ].filter((line): line is string => Boolean(line)),
                updatedAt: new Date().toISOString(),
              },
            });
          }
          if (shouldFollow) {
            dispatchWorkbench({ type: "open-tool-panel", tab: paneTab });
          }
        }
        if (payload.resource.kind === "proposal") {
          recordFocus({
            kind: "proposal",
            label: payload.resource.label,
            detail: "Proposed change",
            paneTab: "diff",
          });
          if (shouldFollow) {
            dispatchWorkbench({ type: "open-tool-panel", tab: "diff" });
          }
        }
        if (payload.resource.kind === "workspace") {
          const folder = stringFromRecord(
            recordFromUnknown(payload.data),
            "path",
          );
          // The user asked this chat to open the folder and approved the call.
          // If they have since moved to another chat, opening a project would
          // pull them out of it, so the call only reports what it validated.
          if (folder && isActiveModelWorkspace) {
            void openWorkspaceFolderRef.current?.(folder);
          }
        }
      },
    ).then((unlisten) => {
      if (!isMounted) unlisten();
      else unlistenResource = unlisten;
    });
    return () => {
      isMounted = false;
      unlistenCapability?.();
      unlistenResource?.();
    };
  }, [flushProviderStreamBatches, setEventsForSession]);
}
