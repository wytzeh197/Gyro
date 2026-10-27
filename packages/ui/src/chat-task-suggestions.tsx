import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Gauge,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ComposerEffortSelector } from "./composer-effort-selector";
import { ComposerModelRail, type ModelRailProvider } from "./composer-model-rail";
import type { SessionEvent } from "./types";
import "./chat-task-suggestions.css";

/** One task a reply suggests moving to a chat of its own (GYRO_TASKS line). */
export type ChatTaskSuggestion = {
  /** `<event id>:<index>`, stable for the life of the reply. */
  id: string;
  title: string;
  /** The first message of the new chat; editable before it starts. */
  prompt: string;
  /** Why it belongs in a separate chat, in one short line. */
  why?: string;
};

export type ChatTaskModelChoice = {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
};

export type ChatTaskStart = ChatTaskModelChoice & {
  prompt: string;
  /** Carry a short note from the source chat into the new one. */
  includeContext: boolean;
};

export type ChatTaskStatus = {
  status: "started" | "dismissed";
  /** The chat a started task opened. */
  sessionId?: string;
  chatTitle?: string;
};

export type ChatTaskEffort = { value: string; label: string; isDefault?: boolean };

/** What the app does with a card; the surface supplies the model data. */
export type ChatTaskSuggestionHandlers = {
  statusFor: (taskId: string) => ChatTaskStatus | undefined;
  onStart: (request: {
    task: ChatTaskSuggestion;
    start: ChatTaskStart;
    event: SessionEvent;
  }) => void;
  onDismiss: (task: ChatTaskSuggestion) => void;
  onOpenStarted: (task: ChatTaskSuggestion) => void;
};

export type ChatTaskSuggestionsController = ChatTaskSuggestionHandlers & {
  providers: ModelRailProvider[];
  /** The source chat's model and effort; every card starts from it. */
  defaultChoice?: ChatTaskModelChoice;
  effortsFor: (providerId: string, modelId: string) => ChatTaskEffort[];
  renderLogo: (providerId: string) => ReactNode;
};

/** Where a chat started from a suggested task came from. */
export type ChatTaskOrigin = {
  sourceTitle: string;
  withSummary: boolean;
  onOpenSource?: () => void;
};

export const MAX_CHAT_TASK_SUGGESTIONS = 2;
/** Pending rows under the new-chat composer. */
export const MAX_START_TASK_SUGGESTIONS = 3;

/** A suggestion still waiting in one of the project's recent chats. */
export type ChatStartTaskSuggestion = ChatTaskSuggestion & {
  sourceTitle: string;
};

/** Pending suggestions offered again under the new-chat composer. */
export type ChatStartTaskSuggestionsSource = {
  /** Newest first; resolves empty when there is nothing to offer. */
  load: (workspacePath: string) => Promise<ChatStartTaskSuggestion[]>;
  onStart: (task: ChatStartTaskSuggestion, choice: ChatTaskModelChoice) => void;
  onDismiss: (task: ChatStartTaskSuggestion) => void;
};

export const ChatTaskSuggestionsContext = createContext<
  ChatTaskSuggestionsController | undefined
>(undefined);

/** Tasks the desktop stripped from a reply into `payload.tasks`. */
export function chatTaskSuggestionsFromEvent(
  event: SessionEvent,
): ChatTaskSuggestion[] {
  if (event.kind !== "assistant-message") return [];
  const tasks = (event.payload as Record<string, unknown> | undefined)?.tasks;
  if (!Array.isArray(tasks)) return [];
  const suggestions: ChatTaskSuggestion[] = [];
  tasks.forEach((item, index) => {
    if (suggestions.length >= MAX_CHAT_TASK_SUGGESTIONS) return;
    const record = item as Record<string, unknown> | null;
    const title = typeof record?.title === "string" ? record.title.trim() : "";
    const prompt =
      typeof record?.prompt === "string" ? record.prompt.trim() : "";
    if (!title || !prompt) return;
    const why = typeof record?.why === "string" ? record.why.trim() : "";
    suggestions.push({
      id: `${event.id}:${index}`,
      title,
      prompt,
      ...(why ? { why } : {}),
    });
  });
  return suggestions;
}

/** The cards for one settled reply, when the surface offers task handoff. */
export function ChatEventTaskSuggestions({ event }: { event: SessionEvent }) {
  const controller = useContext(ChatTaskSuggestionsContext);
  const tasks = useMemo(() => chatTaskSuggestionsFromEvent(event), [event]);
  if (!controller?.defaultChoice || tasks.length === 0) return null;
  return (
    <ChatTaskSuggestions controller={controller} event={event} tasks={tasks} />
  );
}

/**
 * Suggested follow-up tasks under a reply. Each card picks its own model and
 * effort with the composer's own pickers, so a task can start on a cheaper or
 * stronger model than the chat it came from.
 */
export function ChatTaskSuggestions({
  controller,
  event,
  tasks,
}: {
  controller: ChatTaskSuggestionsController;
  event: SessionEvent;
  tasks: ChatTaskSuggestion[];
}) {
  const visible = tasks.filter(
    (task) => controller.statusFor(task.id)?.status !== "dismissed",
  );
  const defaultChoice = controller.defaultChoice;
  if (visible.length === 0 || !defaultChoice) return null;
  return (
    <section aria-label="Suggested tasks" className="gyro-task-suggestions">
      <header className="gyro-task-suggestions-title">Suggested tasks</header>
      {visible.map((task) => {
        const status = controller.statusFor(task.id);
        return status?.status === "started" ? (
          <div className="gyro-task-suggestion is-started" key={task.id}>
            <Check aria-hidden="true" size={14} />
            <span className="gyro-task-suggestion-started-label">
              Started in a new chat
            </span>
            <span className="gyro-task-suggestion-started-title">
              {status.chatTitle ?? task.title}
            </span>
            <button
              className="gyro-task-suggestion-link"
              onClick={() => controller.onOpenStarted(task)}
              type="button"
            >
              Open
              <ArrowUpRight aria-hidden="true" size={13} />
            </button>
          </div>
        ) : (
          <TaskCard
            controller={controller}
            defaultChoice={defaultChoice}
            key={task.id}
            onStart={(start) => controller.onStart({ task, start, event })}
            task={task}
          />
        );
      })}
    </section>
  );
}

/**
 * Tasks earlier replies in this project suggested and nobody started yet,
 * under the new-chat composer. A row starts the task in a chat of its own
 * on the model and effort the composer above shows.
 */
export function ChatStartTaskSuggestions({
  choice,
  source,
  workspacePath,
}: {
  choice?: ChatTaskModelChoice;
  source: ChatStartTaskSuggestionsSource;
  workspacePath: string;
}) {
  const { load } = source;
  const [tasks, setTasks] = useState<ChatStartTaskSuggestion[]>([]);
  useEffect(() => {
    let current = true;
    setTasks([]);
    load(workspacePath).then(
      (items) => {
        if (current) setTasks(items);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [load, workspacePath]);

  const shown = tasks.slice(0, MAX_START_TASK_SUGGESTIONS);
  if (shown.length === 0 || !choice) return null;
  const remove = (task: ChatStartTaskSuggestion) =>
    setTasks((items) => items.filter((item) => item.id !== task.id));
  return (
    <section aria-label="Suggested tasks" className="gyro-start-tasks">
      {shown.map((task) => (
        <div className="gyro-start-task" key={task.id}>
          <button
            className="gyro-start-task-main"
            onClick={() => {
              remove(task);
              source.onStart(task, choice);
            }}
            title={[task.sourceTitle, task.why ?? task.prompt]
              .filter(Boolean)
              .join(" \u2014 ")}
            type="button"
          >
            <CornerDownRight
              aria-hidden="true"
              className="gyro-start-task-arrow"
              size={15}
              strokeWidth={1}
            />
            <span className="gyro-start-task-title">{task.title}</span>
          </button>
          <button
            aria-label={`Dismiss "${task.title}"`}
            className="gyro-start-task-dismiss"
            onClick={() => {
              remove(task);
              source.onDismiss(task);
            }}
            type="button"
          >
            <X aria-hidden="true" size={13} />
          </button>
        </div>
      ))}
    </section>
  );
}

/** The first message of a chat a suggested task started names its source. */
export function ChatTaskOriginRow({ origin }: { origin: ChatTaskOrigin }) {
  return (
    <div className="gyro-task-origin">
      <span>Started from</span>
      {origin.onOpenSource ? (
        <button onClick={origin.onOpenSource} type="button">
          {origin.sourceTitle}
        </button>
      ) : (
        <strong>{origin.sourceTitle}</strong>
      )}
      {origin.withSummary ? <span>· with a summary</span> : null}
    </div>
  );
}

function effortFor(
  efforts: ChatTaskEffort[],
  preferred: string | undefined,
): string | undefined {
  if (preferred && efforts.some((effort) => effort.value === preferred)) {
    return preferred;
  }
  return (efforts.find((effort) => effort.isDefault) ?? efforts[0])?.value;
}

function TaskCard({
  task,
  controller,
  defaultChoice,
  onStart,
}: {
  task: ChatTaskSuggestion;
  controller: ChatTaskSuggestionsController;
  defaultChoice: ChatTaskModelChoice;
  onStart: (start: ChatTaskStart) => void;
}) {
  const baseId = useId();
  const [choice, setChoice] = useState(defaultChoice);
  const [prompt, setPrompt] = useState(task.prompt);
  const [includeContext, setIncludeContext] = useState(true);
  const [editing, setEditing] = useState(false);
  const [popover, setPopover] = useState<"model" | "effort">();
  const controlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popover) return;
    const close = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) {
        setPopover(undefined);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover(undefined);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [popover]);

  const provider = controller.providers.find(
    (item) => item.id === choice.providerId,
  );
  const model = provider?.models.find((item) => item.id === choice.modelId);
  const efforts = controller.effortsFor(choice.providerId, choice.modelId);
  const effort = effortFor(efforts, choice.reasoningEffort);
  const effortIndex = Math.max(
    0,
    efforts.findIndex((item) => item.value === effort),
  );
  const effortLabel = efforts[effortIndex]?.label;
  const modelLabel = model?.displayName ?? choice.modelId;
  const promptChanged = prompt.trim() !== task.prompt.trim();

  return (
    <article className="gyro-task-suggestion" data-editing={editing}>
      <div className="gyro-task-suggestion-head">
        <div className="gyro-task-suggestion-text">
          <strong>{task.title}</strong>
          {task.why ? <p>{task.why}</p> : null}
        </div>
        <button
          aria-label={`Dismiss "${task.title}"`}
          className="gyro-task-suggestion-dismiss"
          onClick={() => controller.onDismiss(task)}
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>

      <button
        aria-expanded={editing}
        className="gyro-task-suggestion-disclosure"
        onClick={() => setEditing((open) => !open)}
        type="button"
      >
        <ChevronRight aria-hidden="true" size={13} />
        {editing ? "Prompt" : promptChanged ? "Prompt (edited)" : "Review prompt"}
      </button>
      {editing ? (
        <div className="gyro-task-suggestion-editor">
          <textarea
            aria-label="Prompt for the new chat"
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            value={prompt}
          />
          <label className="gyro-task-suggestion-context">
            <input
              checked={includeContext}
              onChange={(event) => setIncludeContext(event.target.checked)}
              type="checkbox"
            />
            Include a short summary of this chat
          </label>
        </div>
      ) : null}

      <div className="gyro-task-suggestion-bar" ref={controlsRef}>
        <div className="gyro-composer-control gyro-composer-control-model">
          <button
            aria-expanded={popover === "model"}
            aria-haspopup="menu"
            aria-label={`Model: ${modelLabel}`}
            className="gyro-composer-chip gyro-model-chip gyro-task-suggestion-chip"
            onClick={() =>
              setPopover((open) => (open === "model" ? undefined : "model"))
            }
            type="button"
          >
            {controller.renderLogo(choice.providerId)}
            <span className="gyro-composer-label">{modelLabel}</span>
            <ChevronDown aria-hidden="true" size={13} />
          </button>
          {popover === "model" ? (
            <ComposerModelRail
              align="start"
              activeModelId={choice.modelId}
              activeProviderId={choice.providerId}
              id={`${baseId}-model`}
              onConnect={() => setPopover(undefined)}
              onManageProviders={() => setPopover(undefined)}
              onSelectModel={(providerId, modelId) => {
                setPopover(undefined);
                setChoice((current) => ({
                  providerId,
                  modelId,
                  reasoningEffort: effortFor(
                    controller.effortsFor(providerId, modelId),
                    current.reasoningEffort,
                  ),
                }));
              }}
              placement="up"
              providers={controller.providers}
              renderLogo={(item) => controller.renderLogo(item.id)}
            />
          ) : null}
        </div>
        {efforts.length > 0 ? (
          <div className="gyro-composer-control gyro-composer-control-effort">
            <button
              aria-expanded={popover === "effort"}
              aria-haspopup="dialog"
              aria-label={`Reasoning effort: ${effortLabel}`}
              className="gyro-composer-chip gyro-effort-chip gyro-task-suggestion-chip"
              onClick={() =>
                setPopover((open) => (open === "effort" ? undefined : "effort"))
              }
              type="button"
            >
              <Gauge aria-hidden="true" size={13} />
              <span className="gyro-effort-chip-label">{effortLabel}</span>
              <ChevronDown aria-hidden="true" size={13} />
            </button>
            {popover === "effort" ? (
              <ComposerEffortSelector
                id={`${baseId}-effort`}
                labels={efforts.map((item) => item.label)}
                onSelect={(index) => {
                  setPopover(undefined);
                  setChoice((current) => ({
                    ...current,
                    reasoningEffort: efforts[index]?.value,
                  }));
                }}
                placement="up"
                selectedIndex={effortIndex}
              />
            ) : null}
          </div>
        ) : null}
        <button
          className="gyro-task-suggestion-start"
          disabled={!prompt.trim()}
          onClick={() =>
            onStart({
              ...choice,
              reasoningEffort: effort,
              prompt: prompt.trim(),
              includeContext,
            })
          }
          type="button"
        >
          Start in new chat
          <ArrowUpRight aria-hidden="true" size={14} />
        </button>
      </div>
    </article>
  );
}
