import {
  expandAssistantMessageSegments,
  orderedChatTimelineEvents,
} from "./chat-timeline.ts";
import type { SessionEvent } from "./types.ts";

/**
 * The run model: one flat, ordered list of beats, with the raw material of each
 * beat kept intact.
 *
 * The shape this replaces shipped a finished English sentence from the backend
 * and then pattern-matched it back apart in the renderer, so `mcp__github__…`
 * arrived as the string "Used a tool" with the tool name already destroyed.
 * Here every arm keeps its structured field and the wording is derived once, by
 * `runRowText`, at the point of display.
 */

export type WorkStatus = "running" | "done" | "failed";

export type WorkItem =
  | {
      kind: "command";
      id: string;
      status: WorkStatus;
      command: string;
      /** What the command was for, when the provider says. Falls back to the command. */
      intent?: string;
    }
  | {
      kind: "search";
      id: string;
      status: WorkStatus;
      scope: "web" | "project";
      query?: string;
    }
  | {
      kind: "file";
      id: string;
      status: WorkStatus;
      path: string;
      additions?: number;
      deletions?: number;
    }
  | { kind: "memory"; id: string; status: WorkStatus }
  | { kind: "context"; id: string; status: WorkStatus }
  | {
      kind: "tool";
      id: string;
      status: WorkStatus;
      tool: string;
      server?: string;
    };

/**
 * One beat of a run. A work step carries exactly one item: the reference design
 * is a flat rail where seven commands read as seven rows, so nothing here
 * batches. Collapsing happens in the header, by hiding the list entirely.
 */
export type RunStep =
  | { kind: "say"; id: string; at: string; text: string }
  | { kind: "work"; id: string; at: string; item: WorkItem }
  | { kind: "ask"; id: string; at: string; event: SessionEvent };

/**
 * What the run is doing right now. The shape this replaces spread the same
 * information across four unrelated inline conditionals in the turn component —
 * an empty-timeline test, a response-present test, an array `includes` over
 * status strings, and a separately computed interruption flag. As one tagged
 * union the renderer switches once and the checker catches a missed arm.
 */
export type RunPhase =
  | { name: "thinking" }
  | { name: "working" }
  | { name: "finalizing" }
  | { name: "done"; durationMs?: number }
  | {
      name: "failed";
      message: string;
      recoveryKind?: string;
      recoveryMessage?: string;
    }
  | { name: "interrupted" };

/** A file the run touched, available while it is still running. */
export type FileChange = {
  path: string;
  status: WorkStatus;
  additions?: number;
  deletions?: number;
};

export type RunModel = {
  phase: RunPhase;
  startedAt: string;
  steps: RunStep[];
  files: FileChange[];
  response?: SessionEvent;
};

/** Provider status for the turn, already parsed by the caller. */
export type RunStatusInput = {
  status: string;
  message?: string;
  error?: string;
  recoveryKind?: string;
  recoveryMessage?: string;
};

export type BuildRunModelOptions = {
  isRunning?: boolean;
  status?: RunStatusInput;
  startedAt?: string;
  durationMs?: number;
  /**
   * Line counts for a touched path. Provider payloads do not carry diff stats —
   * the workspace's source control does — so without this every file row reads
   * as a bare path with no sense of how much moved.
   */
  fileStats?: (
    path: string,
  ) => { additions?: number; deletions?: number } | undefined;
};

const INFLIGHT_STATUSES = ["queued", "running", "waiting"];
const PROBLEM_STATUSES = ["failed", "blocked", "cancelled"];

export function buildRunModel(
  events: SessionEvent[],
  options: BuildRunModelOptions = {},
): RunModel {
  const ordered = orderedChatTimelineEvents(
    expandAssistantMessageSegments(events),
  );
  const visible = ordered.filter((event) => !isHiddenRunEvent(event));
  const response = closingResponseEvent(visible, options.isRunning ?? false);
  const steps: RunStep[] = [];
  const files: FileChange[] = [];

  for (const event of visible) {
    if (event === response) {
      continue;
    }
    const item = workItemFromEvent(event);
    if (item) {
      if (item.kind === "file") {
        const stats = options.fileStats?.(item.path);
        item.additions = item.additions ?? stats?.additions;
        item.deletions = item.deletions ?? stats?.deletions;
        mergeFileChange(files, item);
      }
      steps.push({ kind: "work", id: event.id, at: event.createdAt, item });
      continue;
    }
    if (event.kind === "assistant-message") {
      const text = event.message.trim();
      if (text) {
        steps.push({ kind: "say", id: event.id, at: event.createdAt, text });
      }
      continue;
    }
    steps.push({ kind: "ask", id: event.id, at: event.createdAt, event });
  }

  return {
    phase: runPhase(steps, response, options),
    startedAt:
      options.startedAt ?? visible[0]?.createdAt ?? new Date(0).toISOString(),
    steps,
    files,
    response,
  };
}

/**
 * The closing assistant message, when it is the answer rather than a preamble.
 *
 * A message only reads as the answer once it is the last thing in the turn.
 * While a run is still going the opening line introduces work that has not
 * happened yet, so it stays a step until some work precedes it — otherwise the
 * first thing a run shows is an "answer".
 *
 * Trailing file activity does not unseat it. A file edit can be reported after
 * the text it belongs to, and treating that as "something followed the answer"
 * would strand the answer in the rail.
 */
function closingResponseEvent(events: SessionEvent[], isRunning: boolean) {
  const spoken = events.filter(
    (event) => event.kind === "assistant-message" && event.message.trim(),
  );
  const closing = spoken.at(-1);
  if (!closing) {
    return undefined;
  }
  const index = events.indexOf(closing);
  const after = events.slice(index + 1);
  const closesTurn = after.every(
    (event) => workItemFromEvent(event)?.kind === "file",
  );
  if (!closesTurn) {
    return undefined;
  }
  const followsWork = events
    .slice(0, index)
    .some((event) => event.kind !== "assistant-message");
  return followsWork || !isRunning ? closing : undefined;
}

function runPhase(
  steps: RunStep[],
  response: SessionEvent | undefined,
  options: BuildRunModelOptions,
): RunPhase {
  const status = options.status;
  const isRunning = options.isRunning ?? false;
  // A turn left in flight by a restart is not still running, and reporting it as
  // "working" would spin a timer nothing is driving.
  if (!isRunning && status && INFLIGHT_STATUSES.includes(status.status)) {
    return { name: "interrupted" };
  }
  if (status && PROBLEM_STATUSES.includes(status.status)) {
    return {
      name: "failed",
      message: status.message ?? status.error ?? "The run stopped early",
      recoveryKind: status.recoveryKind,
      recoveryMessage: status.recoveryMessage,
    };
  }
  if (!isRunning) {
    return { name: "done", durationMs: options.durationMs };
  }
  if (steps.length === 0) {
    return { name: "thinking" };
  }
  return response ? { name: "finalizing" } : { name: "working" };
}

/**
 * The single place an untyped provider-activity payload becomes a typed item.
 *
 * Structured fields win when present so the Stage 5 backend change is purely
 * additive; the label and detail strings stay as the fallback that keeps older
 * persisted sessions rendering.
 */
export function workItemFromEvent(event: SessionEvent): WorkItem | undefined {
  if (event.kind !== "system-event") {
    return undefined;
  }
  const payload = record(event.payload);
  if (text(payload, "kind") !== "provider-activity") {
    return undefined;
  }
  const id = event.id;
  const status = workStatus(text(payload, "status"));
  const label = text(payload, "label") ?? event.message;
  const detail = text(payload, "detail");

  switch (text(payload, "activityKind")) {
    case "command":
      return {
        kind: "command",
        id,
        status,
        command: text(payload, "command") ?? detail ?? label,
        intent: text(payload, "intent"),
      };
    case "file":
      return {
        kind: "file",
        id,
        status,
        path: text(payload, "path") ?? detail ?? stripUpdatedPrefix(label),
        additions: count(payload, "additions"),
        deletions: count(payload, "deletions"),
      };
    case "search": {
      const query = text(payload, "query") ?? detail;
      return {
        kind: "search",
        id,
        status,
        scope: text(payload, "scope") === "project" ? "project" : "web",
        query,
      };
    }
    case "memory":
      return { kind: "memory", id, status };
    case "context":
      return { kind: "context", id, status };
    case "commentary":
      // Commentary is prose, not work. It reaches the rail as a `say` step via
      // the assistant-message path, so it must not become a row here.
      return undefined;
    case "tool":
      return {
        kind: "tool",
        id,
        status,
        ...splitToolName(text(payload, "tool") ?? detail ?? label),
      };
    default:
      // An unrecognised kind is still work that happened. Showing it as a tool
      // keeps the beat rather than dropping it out of the run.
      return { kind: "tool", id, status, ...splitToolName(label) };
  }
}

/**
 * The header line. A duration is only claimed when one is actually known:
 * a failed or interrupted turn has no recorded end, and inventing one from the
 * moment the component happened to mount would put a fictional number on screen.
 */
export function runHeaderLabel(
  phase: RunPhase,
  elapsedLabel: string | undefined,
): string {
  switch (phase.name) {
    case "thinking":
    case "working":
    case "finalizing":
      return elapsedLabel ? `Working for ${elapsedLabel}` : "Working";
    case "done":
      return elapsedLabel ? `Worked for ${elapsedLabel}` : "Worked";
    case "failed":
      return "Stopped";
    case "interrupted":
      return "Interrupted";
  }
}

/** `231` → `3m 51s`, matching the reference header. */
export function formatRunDuration(elapsedSeconds: number): string {
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor(elapsedSeconds / 60) % 60;
  const seconds = elapsedSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
    seconds > 0 || elapsedSeconds === 0 ? `${seconds}s` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Milliseconds between two stamps, or undefined when either is unusable. */
export function elapsedMsBetween(startedAt: string, completedAt?: string) {
  if (!completedAt) {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : undefined;
}

/** Whether the run is still moving, and so whether the header ticks. */
export function isRunPhaseLive(phase: RunPhase) {
  return (
    phase.name === "thinking" ||
    phase.name === "working" ||
    phase.name === "finalizing"
  );
}

export type RunRowText = { label: string; description?: string };

/**
 * The two halves of a row: the bright side names the action, the muted side
 * says what it was for. Splitting them here rather than in CSS keeps the row a
 * dumb two-span render and makes the wording assertable.
 */
export function runRowText(step: RunStep): RunRowText {
  if (step.kind === "say") {
    return { label: step.text };
  }
  if (step.kind === "ask") {
    return { label: step.event.message || "Waiting for approval" };
  }
  const item = step.item;
  switch (item.kind) {
    case "command":
      return { label: "Ran command", description: item.intent ?? item.command };
    case "file":
      return { label: fileVerb(item.status), description: item.path };
    case "search":
      return {
        label: item.scope === "web" ? "Searched the web" : "Searched project",
        description: item.query,
      };
    case "memory":
      return { label: "Edited memory" };
    case "context":
      return {
        label:
          item.status === "running"
            ? "Compacting context"
            : "Compacted context",
      };
    case "tool":
      return {
        label: "Used tool",
        description: item.server ? `${item.server} · ${item.tool}` : item.tool,
      };
  }
}

function fileVerb(status: WorkStatus) {
  if (status === "running") return "Editing file";
  return status === "failed" ? "Edit failed" : "Edited file";
}

/** `mcp__github__create_issue` → `{ server: "github", tool: "create issue" }` */
export function splitToolName(raw: string): { tool: string; server?: string } {
  const trimmed = raw.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(trimmed);
  if (mcp) {
    return {
      server: humanizeToolSegment(mcp[1] as string),
      tool: humanizeToolSegment(mcp[2] as string),
    };
  }
  const capability = /^gyro_capabilities__(.+)$/.exec(trimmed);
  if (capability) {
    return { tool: humanizeToolSegment(capability[1] as string) };
  }
  // A name that is already prose ("Read surfaces.tsx") is left alone; only
  // machine identifiers get their separators opened up.
  return /^[a-z][a-z0-9_-]*$/i.test(trimmed)
    ? { tool: humanizeToolSegment(trimmed) }
    : { tool: trimmed };
}

function humanizeToolSegment(value: string) {
  return value.split(/[_-]/).filter(Boolean).join(" ");
}

function mergeFileChange(
  files: FileChange[],
  item: Extract<WorkItem, { kind: "file" }>,
) {
  // A file touched twice in one run is one entry, carrying the latest status
  // and whichever stats have arrived.
  const existing = files.find((file) => file.path === item.path);
  if (!existing) {
    files.push({
      path: item.path,
      status: item.status,
      additions: item.additions,
      deletions: item.deletions,
    });
    return;
  }
  existing.status = item.status;
  existing.additions = item.additions ?? existing.additions;
  existing.deletions = item.deletions ?? existing.deletions;
}

/** The title marker is an instruction to the app, never a beat in the run. */
function isHiddenRunEvent(event: SessionEvent) {
  if (event.kind !== "system-event") {
    return false;
  }
  const payload = record(event.payload);
  if (text(payload, "kind") !== "provider-activity") {
    return false;
  }
  return (text(payload, "label") ?? event.message).includes(
    "GYRO_SESSION_TITLE:",
  );
}

function stripUpdatedPrefix(label: string) {
  return label.replace(/^Updated\s+/, "");
}

function workStatus(value: string | undefined): WorkStatus {
  return value === "running" || value === "failed" ? value : "done";
}

function record(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function count(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
