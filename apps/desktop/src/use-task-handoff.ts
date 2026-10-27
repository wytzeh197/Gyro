import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getProviderModel,
  providersForConfig,
  type ChatMode,
  type ChatStartTaskSuggestion,
  type ChatStartTaskSuggestionsSource,
  type ChatTaskOrigin,
  type ChatTaskStart,
  type ChatTaskStatus,
  type ChatTaskSuggestion,
  type ChatTaskSuggestionHandlers,
  type GyroConfig,
  type ProviderId,
  type ReasoningEffort,
  type Session,
} from "@gyro-dev/ui";
import type { SessionModelSelection } from "./use-session-model-save";
import { isTauriRuntime } from "./tauri-runtime";

/**
 * Suggested tasks a reply offers (GYRO_TASKS) start in a chat of their own.
 * Which cards were started or dismissed, and which chat each started task
 * opened, lives in this window's storage: it is a convenience on top of the
 * transcript, which stays the record of what was said.
 */
const STORAGE_KEY = "gyro.task-handoff.v1";
/** Enough of the suggesting reply to orient the new chat, not to replay it. */
const SUMMARY_CHARS = 900;

type StoredOrigin = {
  sourceSessionId: string;
  sourceTitle: string;
  withSummary: boolean;
};
type Stored = {
  tasks: Record<string, ChatTaskStatus>;
  origins: Record<string, StoredOrigin>;
};

function readStored(): Stored {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      tasks: saved?.tasks && typeof saved.tasks === "object" ? saved.tasks : {},
      origins:
        saved?.origins && typeof saved.origins === "object" ? saved.origins : {},
    };
  } catch {
    return { tasks: {}, origins: {} };
  }
}

function writeStored(stored: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage can be unavailable; the cards then simply reappear next launch.
  }
}

/** The task prompt, then a short note from the reply that suggested it. */
export function taskPromptWithContext(
  prompt: string,
  sourceTitle: string,
  reply: string,
) {
  // Plain sentences: list bullets, headings and emphasis marks only add noise
  // once the reply is folded onto one line.
  const note = reply
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[#>*-]+|\d+[.)])\s+/, "")
        .replace(/\*\*|__|`/g, ""),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const summary =
    note.length > SUMMARY_CHARS
      ? `${note.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
      : note;
  return summary
    ? `${prompt}\n\n---\nContext from the chat “${sourceTitle}”: ${summary}`
    : prompt;
}

type TaskSend = (
  message: string,
  context: {
    sessionId: string;
    sessionModel: SessionModelSelection;
    workspacePath: string;
    mode: ChatMode;
    preserveDraft: boolean;
    consumeDraftMode: boolean;
  },
) => Promise<boolean | void>;

export function useTaskHandoff({
  config,
  sessions,
  send,
  refreshSessions,
  selectSession,
  notify,
}: {
  config: GyroConfig;
  sessions: Session[];
  send: TaskSend;
  refreshSessions: () => Promise<unknown>;
  selectSession: (sessionId: string) => void;
  notify: (kind: "command-failed", title: string, detail: string) => void;
}) {
  const [stored, setStored] = useState(readStored);
  const storedRef = useRef(stored);
  storedRef.current = stored;
  /** The chat and reply behind each row the new-chat screen offered. */
  const startSourcesRef = useRef<
    Record<
      string,
      { id: string; title: string; workspacePath: string; reply: string }
    >
  >({});
  const loadGeneration = useRef(0);
  const update = useCallback((change: (current: Stored) => Stored) => {
    setStored((current) => {
      const next = change(current);
      writeStored(next);
      return next;
    });
  }, []);

  const startTask = useCallback(
    async (
      source: { id: string; title: string; workspacePath: string },
      request: {
        task: ChatTaskSuggestion;
        start: ChatTaskStart;
        reply: string;
      },
    ): Promise<string | undefined> => {
      const { task, start, reply } = request;
      if (!isTauriRuntime()) {
        notify(
          "command-failed",
          "Task not started",
          "Suggested tasks start new chats in the desktop app.",
        );
        return;
      }
      const provider = providersForConfig(config).find(
        (item) => item.id === start.providerId,
      );
      const model = provider
        ? getProviderModel(provider, start.modelId)
        : undefined;
      const sessionModel: SessionModelSelection = {
        providerId: start.providerId as ProviderId,
        providerLabel: provider?.displayName,
        modelId: start.modelId,
        modelLabel: model?.displayName ?? start.modelId,
        reasoningEffort: start.reasoningEffort as ReasoningEffort | undefined,
      };
      try {
        const session = await invoke<Session>("create_desktop_session", {
          ...sessionModel,
          title: task.title,
          workspacePath: source.workspacePath,
        });
        update((current) => ({
          tasks: {
            ...current.tasks,
            [task.id]: {
              status: "started",
              sessionId: session.id,
              chatTitle: task.title,
            },
          },
          origins: {
            ...current.origins,
            [session.id]: {
              sourceSessionId: source.id,
              sourceTitle: source.title,
              withSummary: start.includeContext,
            },
          },
        }));
        await refreshSessions();
        const sent = await send(
          start.includeContext
            ? taskPromptWithContext(start.prompt, source.title, reply)
            : start.prompt,
          {
            sessionId: session.id,
            sessionModel,
            workspacePath: source.workspacePath,
            mode: "normal",
            preserveDraft: true,
            consumeDraftMode: false,
          },
        );
        if (sent === false) {
          notify(
            "command-failed",
            "Task chat created, not started",
            `Open “${task.title}” and send the prompt when the provider is ready.`,
          );
        }
        return session.id;
      } catch (error) {
        notify("command-failed", "Task not started", String(error));
        return undefined;
      }
    },
    [config, notify, refreshSessions, send, update],
  );

  const loadStartSuggestions = useCallback(
    async (workspacePath: string): Promise<ChatStartTaskSuggestion[]> => {
      const generation = ++loadGeneration.current;
      if (!isTauriRuntime()) return [];
      let rows: Array<{
        id: string;
        title: string;
        prompt: string;
        why?: string;
        sourceSessionId: string;
        sourceTitle: string;
        reply: string;
      }> = [];
      try {
        rows = await invoke("list_start_task_suggestions", {
          workspacePath,
          excludeIds: Object.keys(storedRef.current.tasks),
        });
      } catch {
        rows = [];
      }
      if (generation !== loadGeneration.current) return [];
      const sources: typeof startSourcesRef.current = {};
      const tasks = rows.map((row) => {
        sources[row.id] = {
          id: row.sourceSessionId,
          title: row.sourceTitle,
          workspacePath,
          reply: row.reply,
        };
        return {
          id: row.id,
          title: row.title,
          prompt: row.prompt,
          ...(row.why ? { why: row.why } : {}),
          sourceTitle: row.sourceTitle,
        };
      });
      startSourcesRef.current = sources;
      return tasks;
    },
    [],
  );

  const dismissTask = useCallback(
    (task: ChatTaskSuggestion) =>
      update((current) => ({
        ...current,
        tasks: { ...current.tasks, [task.id]: { status: "dismissed" } },
      })),
    [update],
  );

  const startTaskSuggestions: ChatStartTaskSuggestionsSource = {
    load: loadStartSuggestions,
    onStart: (task, choice) => {
      const source = startSourcesRef.current[task.id];
      if (!source) {
        notify(
          "command-failed",
          "Task not started",
          "That suggestion is no longer available.",
        );
        return;
      }
      void startTask(
        {
          id: source.id,
          title: source.title,
          workspacePath: source.workspacePath,
        },
        {
          task,
          start: { ...choice, prompt: task.prompt, includeContext: true },
          reply: source.reply,
        },
      ).then((sessionId) => {
        if (sessionId) selectSession(sessionId);
      });
    },
    onDismiss: dismissTask,
  };

  const chatProps = (
    session?: Session,
  ): {
    taskSuggestions?: ChatTaskSuggestionHandlers;
    taskOrigin?: ChatTaskOrigin;
    startTaskSuggestions?: ChatStartTaskSuggestionsSource;
  } => {
    if (!session) return { startTaskSuggestions };
    const origin = stored.origins[session.id];
    const source = origin
      ? sessions.find((item) => item.id === origin.sourceSessionId)
      : undefined;
    return {
      startTaskSuggestions,
      taskSuggestions: {
        statusFor: (taskId) => {
          const status = stored.tasks[taskId];
          const opened = status?.sessionId
            ? sessions.find((item) => item.id === status.sessionId)
            : undefined;
          return status && opened
            ? { ...status, chatTitle: opened.title }
            : status;
        },
        onStart: (request) =>
          void startTask(
            {
              id: session.id,
              title: session.title,
              workspacePath: session.workspacePath,
            },
            {
              task: request.task,
              start: request.start,
              reply: request.event.message,
            },
          ),
        onDismiss: dismissTask,
        onOpenStarted: (task) => {
          const sessionId = stored.tasks[task.id]?.sessionId;
          if (sessionId && sessions.some((item) => item.id === sessionId)) {
            selectSession(sessionId);
          } else {
            notify(
              "command-failed",
              "Chat not found",
              "The chat this task started was deleted.",
            );
          }
        },
      },
      taskOrigin: origin
        ? {
            sourceTitle: source?.title ?? origin.sourceTitle,
            withSummary: origin.withSummary,
            onOpenSource: source
              ? () => selectSession(origin.sourceSessionId)
              : undefined,
          }
        : undefined,
    };
  };

  return { chatProps };
}
