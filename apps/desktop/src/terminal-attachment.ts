import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  NEW_CHAT_DRAFT_KEY,
  absoluteWorkspaceFilePath,
  buildTerminalFailureContext,
  type ChatAttachment,
  type TaskDefinition,
  type TerminalAttachmentActions,
  type TerminalFailureSource,
  type TerminalPane,
  type WorkbenchAction,
  type WorkbenchState,
} from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

/**
 * Where each terminal-output attachment came from. The stored message keeps
 * only the attachment, so the transcript's Re-run and the composer's
 * out-of-date marker read their source from here. Persisted so Re-run
 * survives a reload; bounded because nothing ever needs an old one.
 */
export type TerminalAttachmentSourceRecord = {
  origin:
    | { kind: "task"; taskId: string; lastRunAt?: string }
    | {
        kind: "pane";
        paneId: string;
        command: string;
        status: TerminalPane["status"];
      };
  label: string;
  capturedAt: string;
};

const TERMINAL_ATTACHMENT_SOURCES_KEY = "gyro.terminal-attachment-sources.v1";
const TERMINAL_ATTACHMENT_SOURCE_LIMIT = 200;

function loadTerminalAttachmentSources() {
  const sources = new Map<string, TerminalAttachmentSourceRecord>();
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(TERMINAL_ATTACHMENT_SOURCES_KEY) ?? "[]",
    );
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          entry[1] &&
          typeof entry[1] === "object"
        ) {
          sources.set(entry[0], entry[1] as TerminalAttachmentSourceRecord);
        }
      }
    }
  } catch {
    // A corrupt record only costs the Re-run button on old attachments.
  }
  return sources;
}

function saveTerminalAttachmentSources(
  sources: Map<string, TerminalAttachmentSourceRecord>,
) {
  try {
    window.localStorage.setItem(
      TERMINAL_ATTACHMENT_SOURCES_KEY,
      JSON.stringify([...sources.entries()]),
    );
  } catch {
    // Storage full or unavailable: Re-run still works for this session.
  }
}

/**
 * One bounded store for the whole app. The session-migration path re-keys a
 * captured attachment outside this hook, so the map and its change
 * notification live here instead of in a component ref.
 */
const terminalAttachmentSources = loadTerminalAttachmentSources();
const terminalAttachmentSourceListeners = new Set<() => void>();
let terminalAttachmentSourcesVersion = 0;

export function readTerminalAttachmentSource(attachmentId: string) {
  return terminalAttachmentSources.get(attachmentId);
}

export function rememberTerminalAttachmentSource(
  attachmentId: string,
  record: TerminalAttachmentSourceRecord,
) {
  const sources = terminalAttachmentSources;
  sources.delete(attachmentId);
  sources.set(attachmentId, record);
  while (sources.size > TERMINAL_ATTACHMENT_SOURCE_LIMIT) {
    const oldest = sources.keys().next().value;
    if (oldest === undefined) break;
    sources.delete(oldest);
  }
  saveTerminalAttachmentSources(sources);
  terminalAttachmentSourcesVersion += 1;
  for (const listener of terminalAttachmentSourceListeners) listener();
}

function subscribeTerminalAttachmentSources(listener: () => void) {
  terminalAttachmentSourceListeners.add(listener);
  return () => {
    terminalAttachmentSourceListeners.delete(listener);
  };
}

function terminalAttachmentSourcesVersionValue() {
  return terminalAttachmentSourcesVersion;
}

function terminalAttachmentSourceIsStale(
  record: TerminalAttachmentSourceRecord,
  tasks: TaskDefinition[],
  panes: TerminalPane[],
) {
  if (record.origin.kind === "task") {
    const taskId = record.origin.taskId;
    const task = tasks.find((item) => item.id === taskId);
    return Boolean(task && task.lastRunAt !== record.origin.lastRunAt);
  }
  const paneId = record.origin.paneId;
  const pane = panes.find((item) => item.id === paneId);
  // A pane that failed and is running again has restarted since the capture.
  return Boolean(
    pane && record.origin.status !== "running" && pane.status === "running",
  );
}

function isInteractiveShellCommand(command: string) {
  const program = command.trim().split(/\s+/)[0] ?? "";
  return /(?:^|\/)(?:zsh|bash|sh|fish|nu|dash|ksh|tcsh|pwsh|powershell|cmd)(?:\.exe)?$/i.test(
    program,
  );
}

/**
 * What the controller reads from App: the draft a capture attaches to, the
 * workbench state it reads, and the two commands Re-run replays.
 */
export type TerminalAttachmentControllerDeps = {
  activeDraftKey: string;
  activeSessionId?: string | null;
  chatAttachments: Record<string, ChatAttachment[]>;
  dispatchWorkbench: (action: WorkbenchAction) => void;
  notify: (
    kind: "terminal" | "command-failed",
    title: string,
    detail: string,
  ) => void;
  restartTerminalPane: (paneId: string) => void;
  runIdeTask: (task: TaskDefinition) => void;
  setChatAttachments: Dispatch<
    SetStateAction<Record<string, ChatAttachment[]>>
  >;
  setChatDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  terminalPanesRef: { current: TerminalPane[] };
  workbench: WorkbenchState;
  workspaceActionRoot?: string;
  workspaceName: (path: string) => string;
  workspacePath?: string;
};

/**
 * Terminal output as chat context: capture a failure into an attachment,
 * remember where it came from so Re-run can replay it, and mark it stale once
 * its command has run again.
 */
export function useTerminalAttachmentController(
  deps: TerminalAttachmentControllerDeps,
) {
  const {
    activeDraftKey,
    activeSessionId,
    chatAttachments,
    dispatchWorkbench,
    notify,
    restartTerminalPane,
    runIdeTask,
    setChatAttachments,
    setChatDrafts,
    terminalPanesRef,
    workbench,
    workspaceActionRoot,
    workspaceName,
    workspacePath,
  } = deps;

  const terminalAttachmentSourcesVersion = useSyncExternalStore(
    subscribeTerminalAttachmentSources,
    terminalAttachmentSourcesVersionValue,
  );

  const attachTerminalContext = useCallback(
    async (
      source: TerminalFailureSource,
      origin: TerminalAttachmentSourceRecord["origin"],
    ) => {
      if (!isTauriRuntime()) {
        notify(
          "command-failed",
          "Terminal output unavailable",
          "Sending terminal output to a chat needs the Gyro desktop app.",
        );
        return;
      }
      const root = workspaceActionRoot ?? workspacePath ?? undefined;
      const context = buildTerminalFailureContext({
        ...source,
        branch: source.branch ?? workbench.ide.sourceControl.branch,
        workspaceRoot: root,
      });
      if (!source.output.trim()) {
        notify(
          "command-failed",
          "Nothing to send",
          `${source.label} has no output yet.`,
        );
        return;
      }
      const draftKey = activeDraftKey;
      const sessionId = activeSessionId ?? NEW_CHAT_DRAFT_KEY;
      try {
        const attachment = await invoke<ChatAttachment>(
          "prepare_chat_attachment",
          {
            request: {
              sessionId,
              path: "",
              workspacePath: root,
              kind: "terminal-output",
              name: context.name,
              bytes: Array.from(new TextEncoder().encode(context.text)),
            },
          },
        );
        // The files the output points at go along as current workspace files,
        // so the model reads the code as it is rather than the error's quote.
        const alreadyAttached = new Set(
          (chatAttachments[draftKey] ?? [])
            .map((item) => item.relativePath)
            .filter(Boolean),
        );
        const referencedFiles = root
          ? (
              await Promise.all(
                context.referencedFiles
                  .filter((file) => !alreadyAttached.has(file.path))
                  .map((file) =>
                    invoke<ChatAttachment>("prepare_chat_attachment", {
                      request: {
                        sessionId,
                        path: absoluteWorkspaceFilePath(root, file.path),
                        workspacePath: root,
                        kind: "workspace-file",
                        name: workspaceName(file.path),
                      },
                    }).catch(() => undefined),
                  ),
              )
            ).filter((item): item is ChatAttachment => Boolean(item))
          : [];
        rememberTerminalAttachmentSource(attachment.id, {
          origin,
          label: source.label,
          capturedAt: new Date().toISOString(),
        });
        setChatAttachments((current) => ({
          ...current,
          [draftKey]: [
            ...(current[draftKey] ?? []),
            attachment,
            ...referencedFiles,
          ],
        }));
        // Nothing is sent: the person adds what they know about the failure.
        setChatDrafts((current) =>
          current[draftKey]?.trim()
            ? current
            : { ...current, [draftKey]: "Fix this error." },
        );
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "thread",
        });
        notify(
          "terminal",
          source.isSelection
            ? "Terminal selection attached"
            : "Terminal output attached",
          referencedFiles.length
            ? `${source.label} · ${referencedFiles.length} referenced file${referencedFiles.length === 1 ? "" : "s"} included`
            : source.label,
        );
      } catch (error) {
        notify("command-failed", "Terminal output rejected", String(error));
      }
    },
    [
      activeDraftKey,
      activeSessionId,
      chatAttachments,
      notify,
      workbench.ide.sourceControl.branch,
      workspaceActionRoot,
      workspacePath,
    ],
  );

  const terminalPaneOrigin = useCallback(
    (pane: TerminalPane): TerminalAttachmentSourceRecord["origin"] => {
      const task = pane.workspaceTaskId
        ? workbench.ide.taskDefinitions.find(
            (item) => item.id === pane.workspaceTaskId,
          )
        : undefined;
      return task
        ? { kind: "task", taskId: task.id, lastRunAt: task.lastRunAt }
        : {
            kind: "pane",
            paneId: pane.id,
            command: pane.command,
            status: pane.status,
          };
    },
    [workbench.ide.taskDefinitions],
  );

  const fixIdeTaskWithAi = useCallback(
    (task: TaskDefinition) => {
      // Dev tasks run in a live terminal; the rest write an output channel.
      const pane = workbench.terminalPanes.find(
        (item) => item.workspaceTaskId === task.id,
      );
      const channelId = task.outputChannelId ?? `task-${task.id}`;
      const output =
        pane?.output ??
        workbench.ide.outputChannels
          .find((channel) => channel.id === channelId)
          ?.lines.join("\n") ??
        "";
      void attachTerminalContext(
        {
          label: task.label,
          command: [task.command, ...task.args].join(" "),
          workingDirectory: task.cwd ?? workspaceActionRoot ?? undefined,
          exitCode: pane?.exitCode,
          status: task.status,
          output,
        },
        { kind: "task", taskId: task.id, lastRunAt: task.lastRunAt },
      );
    },
    [
      attachTerminalContext,
      workbench.ide.outputChannels,
      workbench.terminalPanes,
      workspaceActionRoot,
    ],
  );

  const sendTerminalPaneToChat = useCallback(
    (paneId: string, selection?: string) => {
      const pane = terminalPanesRef.current.find((item) => item.id === paneId);
      if (!pane) return;
      void attachTerminalContext(
        {
          label: pane.taskTitle ?? pane.title,
          command: pane.command,
          workingDirectory: pane.workingDirectory ?? pane.projectPath,
          exitCode: pane.exitCode,
          status: pane.status,
          output: selection ?? pane.output,
          isSelection: selection !== undefined,
        },
        terminalPaneOrigin(pane),
      );
    },
    [attachTerminalContext, terminalPaneOrigin],
  );
  const sendTerminalErrorToChat = useCallback(
    (paneId: string) => sendTerminalPaneToChat(paneId),
    [sendTerminalPaneToChat],
  );
  const sendTerminalSelectionToChat = useCallback(
    (paneId: string, selection: string) =>
      sendTerminalPaneToChat(paneId, selection),
    [sendTerminalPaneToChat],
  );

  const terminalAttachmentActions = useMemo<TerminalAttachmentActions>(() => {
    const target = (attachmentId: string) => {
      const record = terminalAttachmentSources.get(attachmentId);
      if (!record) return undefined;
      if (record.origin.kind === "task") {
        const taskId = record.origin.taskId;
        const task = workbench.ide.taskDefinitions.find(
          (item) => item.id === taskId,
        );
        return task ? { kind: "task" as const, task } : undefined;
      }
      const { paneId, command } = record.origin;
      // A shell's own command is the shell; the command that failed inside it
      // is not known, so there is nothing honest to re-run.
      return workbench.terminalPanes.some((pane) => pane.id === paneId) &&
        !isInteractiveShellCommand(command)
        ? { kind: "pane" as const, paneId }
        : undefined;
    };
    return {
      canRerun: (attachmentId) => Boolean(target(attachmentId)),
      rerun: (attachmentId) => {
        const resolved = target(attachmentId);
        if (!resolved) {
          notify(
            "command-failed",
            "Cannot re-run",
            "The command or terminal this output came from is no longer available.",
          );
          return;
        }
        if (resolved.kind === "task") {
          void runIdeTask(resolved.task);
        } else {
          void restartTerminalPane(resolved.paneId);
        }
      },
    };
    // The version bump re-creates the actions when a source is recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    notify,
    restartTerminalPane,
    runIdeTask,
    terminalAttachmentSourcesVersion,
    workbench.ide.taskDefinitions,
    workbench.terminalPanes,
  ]);

  // A captured failure goes out of date when its command runs again before
  // the message is sent; the chip says so rather than passing it off as current.
  useEffect(() => {
    setChatAttachments((current) => {
      let changed = false;
      const next: typeof current = {};
      for (const [key, attachments] of Object.entries(current)) {
        next[key] = attachments.map((attachment) => {
          if (attachment.kind !== "terminal-output") return attachment;
          const record = terminalAttachmentSources.get(attachment.id);
          if (!record) return attachment;
          const stale = terminalAttachmentSourceIsStale(
            record,
            workbench.ide.taskDefinitions,
            workbench.terminalPanes,
          );
          if (Boolean(attachment.stale) === stale) return attachment;
          changed = true;
          return { ...attachment, stale };
        });
      }
      return changed ? next : current;
    });
  }, [workbench.ide.taskDefinitions, workbench.terminalPanes]);

  return {
    attachTerminalContext,
    fixIdeTaskWithAi,
    sendTerminalErrorToChat,
    sendTerminalSelectionToChat,
    terminalAttachmentActions,
  };
}
