import {
  isAssistantPreambleBlock,
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
type CommandCategory = "inspect" | "test" | "build";

export type WorkItem =
  | {
      kind: "command";
      id: string;
      status: WorkStatus;
      command: string;
      category?: CommandCategory;
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
  /**
   * The agent looked at something. Deliberately not a `file` item: a read is
   * not a change, so it must not reach the turn's changed-file set or borrow
   * the pencil.
   */
  | {
      kind: "read";
      id: string;
      status: WorkStatus;
      path?: string;
      media: "image" | "file";
    }
  | { kind: "memory"; id: string; status: WorkStatus }
  | { kind: "context"; id: string; status: WorkStatus }
  | {
      kind: "browser";
      id: string;
      status: WorkStatus;
      action: "browse" | "inspect" | "capture";
      target?: string;
    }
  | {
      kind: "tool";
      id: string;
      status: WorkStatus;
      tool: string;
      server?: string;
      /**
       * What the tool ran on, when the provider sent a machine identity as the
       * tool name (Bash, Skill, mcp__…). Shown muted next to the bright label.
       */
      note?: string;
    };

/**
 * One beat of a run. A work step carries exactly one item: the reference design
 * is a flat rail where seven *different* commands read as seven rows, so no
 * grouping happens by time or by kind. The one thing that folds is a beat that
 * would repeat a row verbatim — see `absorbRepeatedWork`. Collapsing the rest
 * happens in the header, by hiding the list entirely.
 */
export type RunStep =
  | { kind: "say"; id: string; at: string; text: string }
  | {
      kind: "work";
      id: string;
      at: string;
      item: WorkItem;
      /**
       * How many beats folded into this row. Absent or 1 means it happened
       * once; the view only draws a count above that.
       */
      repeat?: number;
    }
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
  /**
   * The transport went away mid-run and the turn is waiting to reach the
   * provider again. Live, not failed: the work behind it is intact, so the rail
   * keeps its shape and the failure block stays out of the way until the retry
   * gives up for good.
   */
  | { name: "retrying"; attempt?: number; reason?: string }
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
  /**
   * Set while the surface is trying to reach the provider again. Only the chat
   * surface knows this — it owns the network watch and fires the resend — so the
   * run model takes it as an input rather than guessing from a stale status.
   */
  retry?: { attempt?: number; reason?: string };
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
  // Peeled preambles rejoin the rail below, so the main pass has to skip the
  // originals — otherwise a real (non-synthetic) preamble event is drawn twice.
  const consumedResponseIds = new Set([
    ...(closing?.sourceIds ?? []),
    ...(closing?.preambles ?? []).map((event) => event.id),
  ]);

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
      if (!absorbRepeatedWork(steps, item)) {
        steps.push({ kind: "work", id: event.id, at: event.createdAt, item });
      }
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

  // Providers of every kind leave intermediate tool frames as "running" when
  // they end a turn without a final status update. Once the surface is no
  // longer driving the turn, nothing is still running — settle the rail so
  // settled turns do not breathe forever or look mid-flight.
  const isRunning = options.isRunning ?? false;
  const settledSteps = isRunning
    ? coalesceAdjacentToolSteps(steps)
    : settleRunningWorkSteps(coalesceAdjacentToolSteps(steps));
  const settledFiles = isRunning
    ? files
    : files.map((file) =>
        file.status === "running" ? { ...file, status: "done" as const } : file,
      );

  return {
    phase: runPhase(settledSteps, closing?.response, options),
    startedAt:
      options.startedAt ?? visible[0]?.createdAt ?? new Date(0).toISOString(),
    steps: settledSteps,
    files: settledFiles,
    response: closing?.response,
  };
}

/** Close open work rows when the turn itself has finished. */
function settleRunningWorkSteps(steps: RunStep[]): RunStep[] {
  return steps.map((step) => {
    if (step.kind !== "work" || step.item.status !== "running") {
      return step;
    }
    return {
      ...step,
      item: { ...step.item, status: "done" },
    };
  });
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
  // Include the note so consecutive Skill/Bash-shaped rows with different
  // targets stay as separate beats instead of collapsing into one.
  return `${item.server ?? ""}::${item.tool}::${item.note ?? ""}`.toLowerCase();
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
  // Narration that trails the last tool is still narration while the run is
  // going: it is the beat the rail should be showing, not an answer. Peeling
  // below always keeps one block back, so without this a lone "Let me check the
  // build config." becomes the response body and reports the turn as
  // finalizing. A settled turn still needs something to answer with, so the
  // rule is scoped to live runs.
  if (isRunning && trailing.every(isNarrationOnly)) {
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

/**
 * True when nothing in an assistant message reads as an answer — every block is
 * a plan line, a status line, or a stray fragment. A message left with no usable
 * blocks at all counts, since what it held was dropped as noise.
 */
function isNarrationOnly(event: SessionEvent): boolean {
  return structuredCommentaryBlocks(event.message).every(
    isAssistantPreambleBlock,
  );
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
  // A retry in flight outranks the status that provoked it: the provider's last
  // word is by definition stale while the surface is dialling again, and showing
  // "Stopped" over a live reconnect reads as a dead turn the user has to rescue.
  if (isRunning && options.retry) {
    return {
      name: "retrying",
      attempt: options.retry.attempt,
      reason: options.retry.reason,
    };
  }
  // The open invoke owns the rail. A stale failed/cancelled status event must
  // not paint "Stopped" while the provider process is still running — that is
  // exactly the "random stop" look mid-tool.
  if (isRunning) {
    if (steps.length === 0) {
      return { name: "thinking" };
    }
    return response ? { name: "finalizing" } : { name: "working" };
  }
  if (status && PROBLEM_STATUSES.includes(status.status)) {
    const cancelled = status.status === "cancelled";
    return {
      name: "failed",
      message: cancelled
        ? (status.message?.trim() || "Stopped")
        : (status.message ?? status.error ?? "The run stopped early"),
      // Normalize so the header and problem tone can tell user-stop from crash.
      recoveryKind: cancelled
        ? (status.recoveryKind ?? "cancelled")
        : status.recoveryKind,
      recoveryMessage: status.recoveryMessage,
    };
  }
  return { name: "done", durationMs: options.durationMs };
}

function classifyCommandActivity({
  command,
  id,
  intent,
  status,
}: {
  command: string;
  id: string;
  intent?: string;
  status: WorkStatus;
}): WorkItem {
  const normalized = command
    .replace(/^\s*(?:cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, "")
    .trim();
  if (/^(?:rg|grep)\b/i.test(normalized)) {
    return {
      kind: "search",
      id,
      status,
      scope: "project",
      query: commandTarget(normalized),
    };
  }
  if (/^(?:sed|head|tail|cat|awk)\b/i.test(normalized)) {
    const path = commandFileTarget(normalized);
    return {
      kind: "read",
      id,
      status,
      path,
      media: isImagePath(path) ? "image" : "file",
    };
  }
  const category: CommandCategory | undefined =
    /(?:^|\s)(?:pnpm|npm|yarn|bun|cargo)\s+(?:run\s+)?test\b|\bcargo\s+test\b/i.test(normalized)
      ? "test"
      : /(?:^|\s)(?:pnpm|npm|yarn|bun|cargo)\s+(?:run\s+)?build\b|\bcargo\s+build\b/i.test(normalized)
        ? "build"
        : /^(?:git\s+(?:status|diff|log|branch)|ls\b|find\b|pwd\b)/i.test(normalized)
          ? "inspect"
          : undefined;
  return { kind: "command", id, status, command, intent, category };
}

function commandTarget(command: string) {
  const quoted = command.match(/["']([^"']+)["']/)?.[1];
  return quoted ?? command.replace(/^(?:rg|grep)\s+[^\s]+\s*/i, "").slice(0, 160);
}

function commandFileTarget(command: string) {
  const tokens = command.match(/(?:["'][^"']+["']|\S+)/g) ?? [];
  const candidate = tokens.at(-1)?.replace(/^['"]|['"]$/g, "");
  return candidate && !candidate.startsWith("-") ? candidate : undefined;
}

/**
 * The single place an untyped provider-activity payload becomes a typed item.
 *
 * Structured fields win when present so the Stage 5 backend change is purely
 * additive; the label and detail strings stay as the fallback that keeps older
 * persisted sessions rendering.
 *
 * Capability calls (`gyro.capability.v1`) also land here so workspace gathering
 * and other tools share the same minimal run-rail row as thinking / commands,
 * instead of the old card chrome.
 */
export function workItemFromEvent(event: SessionEvent): WorkItem | undefined {
  if (event.kind !== "system-event") {
    return undefined;
  }
  const payload = record(event.payload);
  const payloadKind = text(payload, "kind");

  if (payloadKind === "capability-call") {
    return workItemFromCapabilityCall(event, payload);
  }

  if (payloadKind !== "provider-activity") {
    return undefined;
  }
  const id = event.id;
  const status = workStatus(text(payload, "status"));
  const label = text(payload, "label") ?? event.message;
  const detail = text(payload, "detail");

  switch (text(payload, "activityKind")) {
    case "command":
      return classifyCommandActivity({
        command: text(payload, "command") ?? detail ?? label,
        id,
        intent: text(payload, "intent") ?? text(payload, "note"),
        status,
      });
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
      // Prefer the structured query; a note is a secondary scope (path) and is
      // not the thing being searched for.
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
        note: text(payload, "note"),
      };
    // ACP providers (Grok/Kimi/Gemini) report native kinds that are not yet
    // renamed on the wire. Map them so the rail can show real verbs.
    case "read": {
      const path = text(payload, "path") ?? detail;
      return {
        kind: "read",
        id,
        status,
        path,
        media: isImagePath(path) ? "image" : "file",
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
      return classifyCommandActivity({
        command: text(payload, "command") ?? detail ?? label,
        id,
        intent: text(payload, "intent") ?? text(payload, "note"),
        status,
      });
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
      return {
        kind: "tool",
        id,
        status,
        ...splitToolName(label),
        note: text(payload, "note"),
      };
  }
}

/**
 * Map a capability-call system event onto a run-rail work item.
 * Keeps the same muted icon + breathe animation as "Thinking" / "Ran command".
 */
function workItemFromCapabilityCall(
  event: SessionEvent,
  payload: Record<string, unknown> | undefined,
): WorkItem | undefined {
  // Accept either schema-tagged payloads or bare capability-call kinds.
  const schema = text(payload, "schema");
  if (schema && schema !== "gyro.capability.v1") {
    return undefined;
  }
  const capabilityId = text(payload, "capabilityId");
  if (!capabilityId) {
    return undefined;
  }
  const id = event.id;
  const status = capabilityWorkStatus(text(payload, "status"));
  const summary = text(payload, "summary");
  const resource = record(payload?.resource);
  const resourceLabel = text(resource, "label");

  // Terminal-shaped work → command row (matches "Ran command").
  if (
    capabilityId.startsWith("terminal-") ||
    capabilityId === "workspace-run-task" ||
    capabilityId === "workspace-run-test"
  ) {
    return classifyCommandActivity({
      command: summary ?? resourceLabel ?? humanizeCapabilityId(capabilityId),
      id,
      intent: summary,
      status,
    });
  }

  // Project search → search row.
  if (capabilityId === "workspace-search") {
    return {
      kind: "search",
      id,
      status,
      scope: "project",
      query: summary ?? resourceLabel,
    };
  }

  // Reading a workspace file is the same beat as a provider read, so it gets
  // the same row rather than a generic wrench.
  if (capabilityId === "workspace-read" || capabilityId === "workspace-read-range") {
    const path = resourceLabel ?? summary;
    return {
      kind: "read",
      id,
      status,
      path,
      media: isImagePath(path) ? "image" : "file",
    };
  }
  if (capabilityId === "workspace-list") {
    return {
      kind: "tool",
      id,
      status,
      tool: humanizeCapabilityId(capabilityId),
    };
  }

  if (capabilityId.startsWith("browser-")) {
    const action = capabilityId === "browser-screenshot"
      ? "capture"
      : capabilityId === "browser-inspect" ||
          capabilityId === "browser-read-page" ||
          capabilityId === "browser-find" ||
          capabilityId === "browser-console" ||
          capabilityId === "browser-network"
        ? "inspect"
        : "browse";
    return { kind: "browser", id, status, action, target: resourceLabel ?? summary };
  }

  // Everything else (workspace-context, browser-*, ide-*, git, diff, …)
  // is a single tool beat with a human label.
  return {
    kind: "tool",
    id,
    status,
    tool: humanizeCapabilityId(capabilityId),
  };
}

function capabilityWorkStatus(value: string | undefined): WorkStatus {
  if (
    value === "requested" ||
    value === "waiting" ||
    value === "running"
  ) {
    return "running";
  }
  if (
    value === "failed" ||
    value === "denied" ||
    value === "cancelled"
  ) {
    return "failed";
  }
  return "done";
}

/** `workspace-context` → `Workspace context` */
function humanizeCapabilityId(capabilityId: string): string {
  const known: Record<string, string> = {
    "workspace-context": "Workspace context",
    "workspace-list": "List workspace",
    "workspace-search": "Workspace search",
    "workspace-read": "Read file",
    "workspace-read-range": "Read file range",
    "workspace-diagnostics": "Workspace diagnostics",
    "workspace-git-status": "Git status",
    "workspace-diff": "Workspace diff",
    "workspace-propose-edit": "Propose edit",
    "workspace-run-task": "Run task",
    "workspace-run-test": "Run tests",
    "workspace-read-output": "Read output",
    "ide-reveal": "Reveal in editor",
    "ide-open-panel": "Open panel",
    "terminal-open": "Open terminal",
    "terminal-read": "Read terminal",
    "terminal-stop": "Stop terminal",
    "browser-open": "Open browser",
    "browser-inspect": "Inspect browser",
    "browser-reload": "Reload browser",
    "browser-screenshot": "Browser screenshot",
    "browser-navigate": "Navigate browser",
    "browser-back": "Browser back",
    "browser-forward": "Browser forward",
    "browser-click": "Browser click",
    "browser-type": "Browser type",
    "browser-scroll": "Browser scroll",
    "browser-form-input": "Browser form input",
    "browser-read-page": "Read page",
    "browser-find": "Find on page",
    "browser-console": "Browser console",
    "browser-network": "Browser network",
  };
  if (known[capabilityId]) {
    return known[capabilityId] as string;
  }
  const human = capabilityId.split("-").filter(Boolean).join(" ");
  return human ? human.charAt(0).toUpperCase() + human.slice(1) : capabilityId;
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
    // The clock is still honest here — the turn never ended — but "Working for"
    // is not, so the header names the wait and the rail row carries the detail.
    case "retrying":
      return elapsedLabel ? `Retrying · ${elapsedLabel}` : "Retrying";
    case "done":
      return elapsedLabel ? `Worked for ${elapsedLabel}` : "Worked";
    case "failed":
      // User cancel is "Stopped"; a real failure is "Failed" so recovery copy
      // and tone can differ without a second chrome system.
      return phase.recoveryKind === "cancelled" ? "Stopped" : "Failed";
    case "interrupted":
      return "Interrupted";
  }
}

/** True when the failed phase is a user-initiated stop rather than a crash. */
export function isCancelledRunPhase(
  phase: RunPhase,
): phase is Extract<RunPhase, { name: "failed" }> {
  return phase.name === "failed" && phase.recoveryKind === "cancelled";
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
    phase.name === "finalizing" ||
    phase.name === "retrying"
  );
}

export type RunRowText = { label: string; description?: string };

/**
 * The retry beat's two halves, in the same shape as every other row so the rail
 * stays one grid. The reason comes from whoever detected the loss, because
 * "Waiting for the network" and "Reconnecting to the provider" are different
 * facts and guessing between them here would put the wrong one on screen.
 */
export function runRetryText(
  phase: Extract<RunPhase, { name: "retrying" }>,
): RunRowText {
  const reason = phase.reason?.trim();
  // The first attempt needs no number — "Attempt 1" implies a series the user
  // has not seen fail yet.
  const attempt =
    phase.attempt !== undefined && phase.attempt > 1
      ? `attempt ${phase.attempt}`
      : undefined;
  return {
    label: "Retrying",
    description:
      reason && attempt
        ? `${reason} · ${attempt}`
        : (reason ?? attempt ?? "Waiting for the connection"),
  };
}

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
      return {
        label:
          item.status === "running"
            ? commandVerb(item.category, true)
            : item.status === "failed"
              ? commandFailedVerb(item.category)
              : commandVerb(item.category, false),
        // Intent (why) wins over the raw command (what). A provider note is the
        // same shape as intent when Bash was reclassified with a description.
        description: item.intent ?? item.command,
      };
    case "file":
      return { label: fileVerb(item.status), description: item.path };
    case "read":
      return {
        label: readVerb(item.status, item.media),
        description: readTarget(item.path),
      };
    case "search":
      return {
        label:
          item.status === "running"
            ? item.scope === "web"
              ? "Searching the web"
              : "Searching project"
            : item.scope === "web"
              ? "Searched the web"
              : "Searched project",
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
    case "browser":
      return {
        label:
          item.status === "running"
            ? item.action === "capture"
              ? "Capturing preview"
              : item.action === "inspect"
                ? "Inspecting page"
                : "Browsing"
            : item.action === "capture"
              ? "Captured preview"
              : item.action === "inspect"
                ? "Inspected page"
                : "Browsed page",
        description: item.target,
      };
    case "tool": {
      const toolLabel = item.server
        ? `${item.server} · ${item.tool}`
        : item.tool;
      const note =
        item.note &&
        item.note.trim() &&
        !isRawToolPayload(item.note) &&
        item.note.trim().toLowerCase() !== item.tool.trim().toLowerCase()
          ? item.note.trim()
          : undefined;
      const withNote = (label: string): RunRowText =>
        note ? { label, description: note } : { label };
      // ACP fallbacks look like "xAI tool" / "Kimi tool". Showing
      // "Used tool · xAI tool" is noise — drop the redundant description.
      if (isGenericProviderToolLabel(toolLabel)) {
        return withNote(
          item.status === "running" ? "Using tool" : "Used tool",
        );
      }
      // Familiar capability labels get a progressive verb while in flight.
      if (item.status === "running") {
        const progressive = progressiveToolLabel(item.tool);
        if (progressive) {
          return withNote(progressive);
        }
      }
      // Prefer a clean tool name as the primary label when we have one; the
      // note is the muted half that stops "Bash · Bash · Bash" rails.
      if (toolLabel && !isRawToolPayload(toolLabel)) {
        return withNote(toolLabel);
      }
      return withNote(
        item.status === "running" ? "Using tool" : "Used tool",
      );
    }
  }
}

function commandVerb(category: CommandCategory | undefined, running: boolean) {
  if (category === "inspect") return running ? "Inspecting workspace" : "Inspected workspace";
  if (category === "test") return running ? "Running tests" : "Ran tests";
  if (category === "build") return running ? "Building project" : "Built project";
  return running ? "Running command" : "Ran command";
}

function commandFailedVerb(category: CommandCategory | undefined) {
  if (category === "test") return "Tests failed";
  if (category === "build") return "Build failed";
  return category === "inspect" ? "Inspection failed" : "Command failed";
}

/** In-flight wording for the tools users see every turn. */
function progressiveToolLabel(tool: string): string | undefined {
  const key = tool.trim().toLowerCase();
  const known: Record<string, string> = {
    "workspace context": "Gathering workspace",
    "list workspace": "Listing workspace",
    "workspace search": "Searching workspace",
    "read file": "Reading file",
    "read file range": "Reading file",
    "workspace diagnostics": "Checking diagnostics",
    "git status": "Checking git status",
    "workspace diff": "Reading diff",
    "propose edit": "Proposing edit",
    "run task": "Running task",
    "run tests": "Running tests",
    "read output": "Reading output",
    "open browser": "Opening browser",
    "browser navigate": "Navigating",
    "browser screenshot": "Capturing browser",
    "inspect browser": "Inspecting browser",
    "reload browser": "Reloading browser",
  };
  return known[key];
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

function readVerb(status: WorkStatus, media: "image" | "file") {
  if (status === "failed") {
    return media === "image" ? "Image failed" : "Read failed";
  }
  if (status === "running") {
    return media === "image" ? "Viewing image" : "Reading file";
  }
  return media === "image" ? "Viewed image" : "Read file";
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "heic",
  "ico",
]);

export function isImagePath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const extension = path.split(".").at(-1)?.toLowerCase();
  return Boolean(extension) && IMAGE_EXTENSIONS.has(extension as string);
}

/**
 * What the rail shows next to a read verb.
 *
 * Chat attachments live as content-hashed blobs under the app's session store,
 * so the real path is a 64-character digest the user has never seen. The
 * filename is the only part of any read path that carries meaning at rail
 * width, and for an attachment even that is noise — so it is dropped entirely
 * and the verb ("Viewed image") stands alone.
 */
function readTarget(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  if (path.includes("/sessions/attachments/")) {
    return "attachment";
  }
  return path;
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

/**
 * Folds a repeated beat into the row that already says it.
 *
 * The rail is otherwise flat on purpose — seven commands read as seven rows.
 * But an agent that edits one file eight times produced eight rows carrying the
 * *same* path and the same `+40`, because the stats are the file's whole diff
 * rather than one edit's share. That is not eight beats of information.
 *
 * Two different reaches, because the two cases are different:
 *
 * - A **file** folds into its earlier row anywhere in the turn. One row per
 *   path, held at the position it was first touched, numbers refreshed in
 *   place. This mirrors `mergeFileChange` so the rail and the turn's changed
 *   files cannot disagree.
 * - **Everything else** folds only when it repeats back to back. A command run
 *   again after other work is a genuine second beat, and pulling it upward
 *   would scramble the order the run actually happened in.
 *
 * Returns whether the item was absorbed.
 */
function absorbRepeatedWork(steps: RunStep[], item: WorkItem): boolean {
  const identity = workIdentity(item);
  if (!identity) {
    return false;
  }
  const target =
    item.kind === "file"
      ? findLastWorkStep(steps, identity)
      : matchingLastStep(steps, identity);
  if (!target) {
    return false;
  }
  target.item = carryWorkStats(target.item, item);
  target.repeat = (target.repeat ?? 1) + 1;
  return true;
}

function findLastWorkStep(steps: RunStep[], identity: string) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.kind === "work" && workIdentity(step.item) === identity) {
      return step;
    }
  }
  return undefined;
}

function matchingLastStep(steps: RunStep[], identity: string) {
  const last = steps.at(-1);
  return last?.kind === "work" && workIdentity(last.item) === identity
    ? last
    : undefined;
}

/**
 * What makes two beats "the same work". A row only folds when its whole visible
 * content would repeat, so an identity is the kind plus everything the row
 * shows. Anything without a target to compare on (memory, context) returns
 * `undefined` and never folds.
 */
function workIdentity(item: WorkItem): string | undefined {
  switch (item.kind) {
    case "file":
      return `file:${item.path}`;
    case "read":
      return item.path ? `read:${item.media}:${item.path}` : undefined;
    case "command":
      return `command:${item.command}`;
    case "search":
      return item.query ? `search:${item.scope}:${item.query}` : undefined;
    case "browser":
      return item.target ? `browser:${item.action}:${item.target}` : undefined;
    case "tool":
      return `tool:${item.server ?? ""}:${item.tool}:${item.note ?? ""}`;
    case "memory":
    case "context":
      return undefined;
  }
}

/**
 * The later beat wins — same rule as `mergeFileChange` — except that a stat the
 * newer beat did not carry keeps the value already on the row, so a provider
 * that only reports line counts once does not blank them on the repeat.
 */
function carryWorkStats(previous: WorkItem, next: WorkItem): WorkItem {
  if (previous.kind !== "file" || next.kind !== "file") {
    return next;
  }
  return {
    ...next,
    additions: next.additions ?? previous.additions,
    deletions: next.deletions ?? previous.deletions,
  };
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

/** Control markers are instructions to the app, never beats in the run. */
function isHiddenRunEvent(event: SessionEvent) {
  if (event.kind !== "system-event") {
    return false;
  }
  const payload = record(event.payload);
  if (text(payload, "kind") !== "provider-activity") {
    return false;
  }
  const label = text(payload, "label") ?? event.message;
  return (
    label.includes("GYRO_SESSION_TITLE:") ||
    label.includes("GYRO_ARTIFACTS:")
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
