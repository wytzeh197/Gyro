import {
  isOrphanAssistantFragment,
  isTransientStatusGreeting,
  peelAssistantPreambleBlocks,
  structuredCommentaryBlocks,
} from "./chat-commentary.ts";
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
  const closing = partitionClosingResponse(visible, options.isRunning ?? false);
  const steps: RunStep[] = [];
  const files: FileChange[] = [];
  const consumedResponseIds = new Set(closing?.sourceIds ?? []);

  for (const event of visible) {
    if (consumedResponseIds.has(event.id)) {
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
      if (
        text &&
        !isOrphanAssistantFragment(text) &&
        !isTransientStatusGreeting(text)
      ) {
        steps.push({ kind: "say", id: event.id, at: event.createdAt, text });
      }
      continue;
    }
    steps.push({ kind: "ask", id: event.id, at: event.createdAt, event });
  }

  // Plan lines peeled from a trailing multi-block answer rejoin the rail as
  // say steps so they stay under "Worked for …" instead of the response body.
  for (const preamble of closing?.preambles ?? []) {
    const text = preamble.message.trim();
    if (
      text &&
      !isOrphanAssistantFragment(text) &&
      !isTransientStatusGreeting(text)
    ) {
      steps.push({
        kind: "say",
        id: preamble.id,
        at: preamble.createdAt,
        text,
      });
    }
  }

  return {
    phase: runPhase(steps, closing?.response, options),
    startedAt:
      options.startedAt ?? visible[0]?.createdAt ?? new Date(0).toISOString(),
    steps: coalesceAdjacentToolSteps(steps),
    files,
    response: closing?.response,
  };
}

/**
 * Consecutive updates for the same tool (running → done, or repeated capability
 * calls with the same name) collapse to one rail row so the timeline does not
 * stack five "Used tool" lines for one workspace-context lookup.
 */
function coalesceAdjacentToolSteps(steps: RunStep[]): RunStep[] {
  const coalesced: RunStep[] = [];
  for (const step of steps) {
    const previous = coalesced.at(-1);
    if (
      step.kind === "work" &&
      step.item.kind === "tool" &&
      previous?.kind === "work" &&
      previous.item.kind === "tool" &&
      toolIdentity(previous.item) === toolIdentity(step.item)
    ) {
      // Keep the latest status/label (failed wins over done only if last).
      coalesced[coalesced.length - 1] = step;
      continue;
    }
    coalesced.push(step);
  }
  return coalesced;
}

function toolIdentity(item: Extract<WorkItem, { kind: "tool" }>): string {
  return `${item.server ?? ""}::${item.tool}`.toLowerCase();
}

type ClosingResponse = {
  response: SessionEvent;
  /** Every original assistant event folded into the answer (skipped as steps). */
  sourceIds: string[];
  /** Leading plan lines peeled out of a multi-block trailing answer. */
  preambles: SessionEvent[];
};

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
 *
 * When several assistant blocks trail the last tool call, leading plan/status
 * lines are peeled into rail preambles so the response body is only the answer.
 */
function partitionClosingResponse(
  events: SessionEvent[],
  isRunning: boolean,
): ClosingResponse | undefined {
  let end = events.length;
  while (end > 0 && workItemFromEvent(events[end - 1]!)?.kind === "file") {
    end -= 1;
  }

  const trailing: SessionEvent[] = [];
  let index = end - 1;
  while (index >= 0 && events[index]!.kind === "assistant-message") {
    const text = events[index]!.message.trim();
    if (text && !isOrphanAssistantFragment(text)) {
      trailing.unshift(events[index]!);
    }
    index -= 1;
  }
  if (trailing.length === 0) {
    return undefined;
  }

  const before = events.slice(0, index + 1);
  const followsWork = before.some(
    (event) => event.kind !== "assistant-message",
  );
  if (isRunning && !followsWork) {
    return undefined;
  }

  // Peel plan/status lines from the trailing blocks. Applies with or without
  // tools — glued pure-Q&A streams often attach "I'll check…" to the answer.
  const blocks = trailing.map((event) => event.message.trim());
  const { preambles: preambleTexts, answer: answerTexts } =
    peelAssistantPreambleBlocks(blocks);
  const preambleEvents = trailing.slice(0, preambleTexts.length);
  const answerEvents = trailing.slice(preambleTexts.length);

  // Single trailing block that still mixes plan + answer as one string.
  if (answerEvents.length === 1) {
    const only = answerEvents[0]!;
    const parts = structuredCommentaryBlocks(only.message);
    if (parts.length > 1) {
      const peeled = peelAssistantPreambleBlocks(parts);
      if (peeled.preambles.length > 0) {
        return {
          response: sanitizeResponseEvent({
            ...only,
            message: peeled.answer.join("\n\n"),
          }),
          sourceIds: [only.id],
          preambles: [
            ...preambleEvents,
            ...peeled.preambles.map((text, peelIndex) => ({
              ...only,
              id: `${only.id}::preamble-${peelIndex}`,
              message: text,
            })),
          ],
        };
      }
    }
  }

  if (answerEvents.length === 0) {
    const fallback = trailing.at(-1)!;
    return {
      response: sanitizeResponseEvent(fallback),
      sourceIds: [fallback.id],
      preambles: trailing.slice(0, -1),
    };
  }

  // Silence unused when peel left answerTexts unused beyond length checks.
  void answerTexts;

  const response =
    answerEvents.length === 1
      ? sanitizeResponseEvent(answerEvents[0]!)
      : sanitizeResponseEvent(joinAssistantEvents(answerEvents));

  return {
    response,
    sourceIds: answerEvents.map((event) => event.id),
    preambles: preambleEvents,
  };
}

function joinAssistantEvents(events: SessionEvent[]): SessionEvent {
  const first = events[0]!;
  return {
    ...first,
    message: events
      .map((event) => event.message.trim())
      .filter(Boolean)
      .join("\n\n"),
  };
}

function sanitizeResponseEvent(event: SessionEvent): SessionEvent {
  const blocks = structuredCommentaryBlocks(event.message);
  const message = blocks.join("\n\n");
  return message === event.message ? event : { ...event, message };
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
    // ACP providers (Grok/Kimi/Gemini) report native kinds that are not yet
    // renamed on the wire. Map them so the rail can show real verbs.
    case "read": {
      const path = text(payload, "path") ?? detail;
      return {
        kind: "tool",
        id,
        status,
        tool:
          label && !isGenericProviderToolLabel(label)
            ? label
            : path
              ? `Read ${path}`
              : "Read file",
      };
    }
    case "edit":
    case "delete":
    case "move":
      return {
        kind: "file",
        id,
        status,
        path: text(payload, "path") ?? detail ?? stripUpdatedPrefix(label),
      };
    case "execute":
      return {
        kind: "command",
        id,
        status,
        command: text(payload, "command") ?? detail ?? label,
        intent: text(payload, "intent"),
      };
    case "fetch":
      return {
        kind: "search",
        id,
        status,
        scope: "web",
        query: text(payload, "query") ?? detail,
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
    case "tool": {
      const description = item.server
        ? `${item.server} · ${item.tool}`
        : item.tool;
      // ACP fallbacks look like "xAI tool" / "Kimi tool". Showing
      // "Used tool · xAI tool" is noise — drop the redundant description.
      if (isGenericProviderToolLabel(description)) {
        return { label: "Used tool" };
      }
      // Prefer a clean tool name as the primary label when we have one.
      if (description && !isRawToolPayload(description)) {
        return { label: description };
      }
      return { label: "Used tool" };
    }
  }
}

/** `{Provider} tool` placeholders that add nothing next to "Used tool". */
export function isGenericProviderToolLabel(value: string): boolean {
  return /^[A-Za-z][\w.+-]*\s+tool$/i.test(value.trim());
}

function isRawToolPayload(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /"tool_name"\s*:/.test(trimmed) ||
    /"toolName"\s*:/.test(trimmed)
  );
}

function fileVerb(status: WorkStatus) {
  if (status === "running") return "Editing file";
  return status === "failed" ? "Edit failed" : "Edited file";
}

/**
 * `mcp__github__create_issue` → `{ server: "github", tool: "create issue" }`
 * Also unwraps JSON payloads like `{"tool_name":"gyro_capabilities__…"}` that
 * some providers put in the activity label.
 */
export function splitToolName(raw: string): { tool: string; server?: string } {
  const extracted = extractToolNameFromRaw(raw);
  const trimmed = extracted.trim();
  const mcp = /^(?:mcp__)?(.+?)__(.+)$/.exec(trimmed);
  if (mcp && !trimmed.includes(" ")) {
    const server = mcp[1] as string;
    const tool = mcp[2] as string;
    // gyro_capabilities__gyro_workspace_get_context → Workspace context
    if (/^gyro_capabilities$/i.test(server) || /^gyro$/i.test(server)) {
      return { tool: humanizeCapabilityTool(tool) };
    }
    return {
      server: humanizeToolSegment(server.replace(/^gyro_capabilities$/i, "gyro")),
      tool: humanizeToolSegment(tool),
    };
  }
  const capability = /^gyro_capabilities__(.+)$/i.exec(trimmed);
  if (capability) {
    return { tool: humanizeCapabilityTool(capability[1] as string) };
  }
  if (/^gyro_[a-z0-9_]+$/i.test(trimmed)) {
    return { tool: humanizeCapabilityTool(trimmed) };
  }
  // A name that is already prose ("Read surfaces.tsx") is left alone; only
  // machine identifiers get their separators opened up.
  return /^[a-z][a-z0-9_-]*$/i.test(trimmed)
    ? { tool: humanizeToolSegment(trimmed) }
    : { tool: trimmed };
}

function extractToolNameFromRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["tool_name", "toolName", "name", "tool", "id"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    } catch {
      // Keep the original string when it is not valid JSON.
    }
  }
  // Nested JSON-ish: tool_name":"foo"
  const embedded =
    /"tool_name"\s*:\s*"([^"]+)"/.exec(trimmed) ??
    /"toolName"\s*:\s*"([^"]+)"/.exec(trimmed);
  if (embedded?.[1]) {
    return embedded[1];
  }
  return trimmed;
}

/** `gyro_workspace_get_context` → `Workspace context` */
function humanizeCapabilityTool(value: string): string {
  let name = value.trim();
  name = name.replace(/^(?:gyro_capabilities__|mcp__gyro_capabilities__)/i, "");
  name = name.replace(/^gyro_/i, "");
  // Known short labels for the tools users see every turn.
  const known: Record<string, string> = {
    workspace_get_context: "Workspace context",
    workspace_search: "Workspace search",
    workspace_read_file: "Read file",
    workspace_list: "List workspace",
    browser_navigate: "Browser navigate",
    browser_snapshot: "Browser snapshot",
    terminal_run: "Run terminal",
  };
  if (known[name]) {
    return known[name] as string;
  }
  const human = humanizeToolSegment(name);
  // Capitalize first letter for a tidy rail label.
  return human ? human.charAt(0).toUpperCase() + human.slice(1) : human;
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
