import {
  finalAssistantResponseText,
  isAssistantPreambleBlock,
  isOrphanAssistantFragment,
  isTransientStatusGreeting,
  peelAssistantPreambleBlocks,
  stripHiddenControlMarkers,
  structuredCommentaryBlocks,
} from "./chat-commentary.ts";
import {
  expandAssistantMessageSegments,
  isDurableAssistantResponse,
  orderedChatTimelineEvents,
} from "./chat-timeline.ts";
import { FILE_REVIEW_SCHEMA } from "./types.ts";
import { reconcileCapabilityCalls } from "./capability-call-lifecycle.ts";
import {
  appliedFileChangeCounts,
  isAppliedFileMutationEvent,
  measuredFileCounts,
} from "./file-change-counts.ts";
import type { SessionEvent } from "./types.ts";
import { isProviderQuotaError, PROVIDER_QUOTA_RECOVERY } from "./provider-quota.ts";
import {
  capabilityLabel,
  capabilityUi,
  type BrowserAction,
} from "./capability-ui.ts";

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

/** Create, rename, move, trash, or duplicate. Content edits leave this unset. */
export type FileLifecycle =
  | "create"
  | "rename"
  | "move"
  | "trash"
  | "duplicate";
type CommandCategory = "inspect" | "test" | "build";

export type WorkItem =
  | {
      kind: "command";
      id: string;
      status: WorkStatus;
      command: string;
      /** Recorded failure details; never inferred from assistant narration. */
      error?: string;
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
      path?: string;
      error?: string;
      errorCode?: string;
    }
  | {
      kind: "file";
      id: string;
      status: WorkStatus;
      path: string;
      additions?: number;
      deletions?: number;
      /**
       * Path lifecycle, not a content edit. Undo on the row reverses the
       * workspace journal. Editor undo stays with Monaco.
       */
      lifecycle?: FileLifecycle;
      /**
       * What the agent said it was doing to this file, in its own words. Free
       * and already true, so the review card prefers it over a line count when
       * no summary has been bought.
       */
      intent?: string;
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
      error?: string;
    }
  | { kind: "memory"; id: string; status: WorkStatus }
  | {
      kind: "context";
      id: string;
      status: WorkStatus;
      /**
       * What a finished compaction actually did. A Codex session summarizes;
       * every other provider condenses the transcript or keeps it whole.
       */
      compaction?: "summarized" | "condensed" | "kept";
    }
  | {
      kind: "browser";
      id: string;
      status: WorkStatus;
      action: BrowserAction;
      /** The element an interaction touched, or the page it happened on. */
      target?: string;
    }
  | {
      kind: "tool";
      id: string;
      status: WorkStatus;
      tool: string;
      server?: string;
      error?: string;
      /**
       * What the tool ran on, when the provider sent a machine identity as the
       * tool name (Bash, Skill, mcp__…). Shown muted next to the bright label.
       */
      note?: string;
      /** Imported arguments and result, preserved for read-only inspection. */
      historicalDetail?: string;
      /** Native call identity prevents distinct imported calls folding together. */
      historicalCallId?: string;
    };

// The verb vocabulary lives with the capability table that names each one.
export type { BrowserAction };

/** One exact event in a run. Work is grouped for display below, never discarded. */
export type RunStep =
  | { kind: "say"; id: string; at: string; text: string }
  /**
   * A reasoning-summary headline ("Checking file sizes"). Not narration — the
   * agent did not say it to the person — so it only ever stands in for the
   * "Thinking" beat at the live tail and is dropped from settled work.
   */
  | { kind: "status"; id: string; at: string; text: string }
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

/** A plain-language phase for a consecutive stretch of work. */
export type WorkGroupKind =
  "review" | "change" | "verify" | "command" | "browser";

export type WorkGroup = {
  kind: "work-group";
  id: string;
  at: string;
  groupKind: WorkGroupKind;
  status: WorkStatus;
  steps: Array<Extract<RunStep, { kind: "work" }>>;
};

/** What the run view renders: narration and approvals keep their place; tool
 * noise becomes a compact, expandable phase. Context compaction is deliberately
 * left as its own row: it changes the conversation the model can see, so hiding
 * it inside an unrelated “Reviewing workspace” group makes an important state
 * transition invisible. */
export type RunDisplayStep = RunStep | WorkGroup;

/**
 * Group consecutive work into the small number of phases a person can scan:
 * review, change, verify, and generic commands. The exact steps remain nested
 * in their group so command output is still inspectable on demand.
 */
export function groupRunSteps(steps: RunStep[]): RunDisplayStep[] {
  const displayed: RunDisplayStep[] = [];
  for (const step of steps) {
    if (step.kind !== "work") {
      displayed.push(step);
      continue;
    }
    // A compaction is not ordinary inspection work. Keep its symbol and status
    // in the visible timeline, including while it is in progress.
    if (step.item.kind === "context") {
      displayed.push(step);
      continue;
    }
    const groupKind = workGroupKind(step.item);
    const previous = displayed.at(-1);
    if (previous?.kind === "work-group" && previous.groupKind === groupKind) {
      previous.steps.push(step);
      previous.status = workGroupStatus(previous.steps);
      continue;
    }
    displayed.push({
      kind: "work-group",
      id: `work-group-${step.id}`,
      at: step.at,
      groupKind,
      status: step.item.status,
      steps: [step],
    });
  }
  return displayed;
}

/** Copy for the group headline. The detail deliberately counts actions rather
 * than exposing implementation commands before someone asks for them. */
export function runWorkGroupText(group: WorkGroup): RunRowText {
  const running = group.status === "running";
  const failed = group.status === "failed";
  const labels: Record<WorkGroupKind, [string, string, string]> = {
    review: [
      "Reviewing workspace",
      "Reviewed workspace",
      "Review needs attention",
    ],
    change: [
      "Updating workspace",
      "Updated workspace",
      "Update needs attention",
    ],
    verify: [
      "Checking the result",
      "Checked the result",
      "Check needs attention",
    ],
    command: ["Running commands", "Ran commands", "Command needs attention"],
    browser: ["Using browser", "Used browser", "Browser needs attention"],
  };
  const [inProgress, complete, problem] = labels[group.groupKind];
  const count = group.steps.length;
  return {
    label: failed ? problem : running ? inProgress : complete,
    description: `${count} ${count === 1 ? "action" : "actions"}`,
  };
}

/**
 * A stretch of the run between two things the agent said.
 *
 * Narration is the story; the tool calls under it are how. So the run reads as
 * say → work → say → work, and a finished work stretch folds to one summary
 * line ("Ran 3 commands, Read 1 file") that opens onto its calls. Approvals
 * split a stretch like narration does, because work after a decision is a
 * different stretch of work.
 */
export type RunSegment =
  | { kind: "say"; id: string; step: Extract<RunStep, { kind: "say" }> }
  | { kind: "ask"; id: string; step: Extract<RunStep, { kind: "ask" }> }
  | {
      kind: "work";
      id: string;
      steps: Array<Extract<RunStep, { kind: "work" | "status" }>>;
    };

export function segmentRunSteps(steps: RunStep[]): RunSegment[] {
  const segments: RunSegment[] = [];
  for (const step of steps) {
    if (step.kind === "say") {
      segments.push({ kind: "say", id: step.id, step });
      continue;
    }
    if (step.kind === "ask") {
      segments.push({ kind: "ask", id: step.id, step });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === "work") {
      previous.steps.push(step);
      continue;
    }
    // Keyed by the first beat, which never changes as the stretch grows, so a
    // summary row keeps its expanded state while later calls land in it.
    segments.push({ kind: "work", id: `segment-${step.id}`, steps: [step] });
  }
  return segments;
}

/** Only the calls in a stretch; reasoning headlines are not work. */
export function segmentWorkSteps(
  steps: RunStep[],
): Array<Extract<RunStep, { kind: "work" }>> {
  return steps.filter(
    (step): step is Extract<RunStep, { kind: "work" }> => step.kind === "work",
  );
}

/** Completed history may fold; running work and failures must remain visible. */
export function partitionSegmentCalls(
  calls: Array<Extract<RunStep, { kind: "work" }>>,
) {
  const completed: typeof calls = [];
  const visible: typeof calls = [];
  for (const call of calls) {
    (call.item.status === "done" ? completed : visible).push(call);
  }
  return { completed, visible };
}

type SegmentCountKey =
  "command" | "read" | "file" | "search" | "browser" | "other";

const SEGMENT_PHRASES = {
  command: (n) => `Ran ${n} ${n === 1 ? "command" : "commands"}`,
  read: (n) => `Read ${n} ${n === 1 ? "file" : "files"}`,
  file: (n) => `Edited ${n} ${n === 1 ? "file" : "files"}`,
  search: (n) => `Ran ${n} ${n === 1 ? "search" : "searches"}`,
  browser: (n) => `${n} browser ${n === 1 ? "action" : "actions"}`,
  other: (n) => `${n} other tool ${n === 1 ? "call" : "calls"}`,
} as const satisfies Record<SegmentCountKey, (count: number) => string>;

/** Past this many named kinds the rest fold into "N other tool calls". */
const SEGMENT_NAMED_PARTS = 3;

/**
 * One line for a finished stretch of work: "Ran 3 commands, Read 1 file,
 * 3 other tool calls".
 *
 * Kinds are named in the order they first happened, so the line retells the
 * stretch rather than sorting it. Edits and reads count distinct paths — two
 * edits to one file are one edited file — while everything else counts calls,
 * folded repeats included. A failure is appended rather than hidden inside a
 * count, because it is the one thing in the line a person may need to act on.
 */
export function summarizeSegment(steps: RunStep[]): string {
  const counts = new Map<SegmentCountKey, number>();
  const paths = { file: new Set<string>(), read: new Set<string>() };
  let failed = 0;
  const add = (key: SegmentCountKey, amount: number) =>
    counts.set(key, (counts.get(key) ?? 0) + amount);

  for (const step of segmentWorkSteps(steps)) {
    const { item } = step;
    const times = step.repeat ?? 1;
    if (item.status === "failed") failed += 1;
    switch (item.kind) {
      case "command":
      case "search":
      case "browser":
        add(item.kind, times);
        break;
      case "file":
      case "read": {
        const path = item.path;
        if (!path) {
          add(item.kind, times);
        } else if (!paths[item.kind].has(path)) {
          paths[item.kind].add(path);
          add(item.kind, 1);
        } else {
          add(item.kind, 0);
        }
        break;
      }
      case "tool":
      case "memory":
      case "context":
        add("other", times);
        break;
    }
  }

  const named = [...counts.keys()].filter((key) => key !== "other");
  const shown = named.slice(0, SEGMENT_NAMED_PARTS);
  const folded =
    (counts.get("other") ?? 0) +
    named
      .slice(SEGMENT_NAMED_PARTS)
      .reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
  const parts = shown.map((key) => SEGMENT_PHRASES[key](counts.get(key)!));
  if (folded > 0) {
    parts.push(
      parts.length === 0
        ? `Used ${folded} ${folded === 1 ? "tool" : "tools"}`
        : SEGMENT_PHRASES.other(folded),
    );
  }
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  return parts.join(", ");
}

/**
 * Split a segment summary so only the failure clause can be emphasized.
 *
 * The rest of the line is ordinary work ("Ran 14 commands, Read 7 files").
 * "3 failed" is the only part that should read as a problem.
 */
export function splitSegmentSummary(summary: string): {
  lead: string;
  failed: string | null;
} {
  const match = summary.match(/^(.*), (\d+ failed)$/);
  if (!match) return { lead: summary, failed: null };
  return { lead: match[1] ?? summary, failed: match[2] ?? null };
}

/**
 * The line delta for a finished stretch, drawn after its summary the way a
 * file row draws `+26 -9`.
 *
 * Only edits contribute. A file with no measured count omits the total, so a
 * partial sum is never presented as everything the stretch changed.
 */
export function segmentLineStats(
  steps: RunStep[],
): { additions: number; deletions: number } | undefined {
  const files = segmentWorkSteps(steps).flatMap((step) =>
    step.item.kind === "file" ? [step.item] : [],
  );
  if (files.length === 0) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (file.additions == null && file.deletions == null) return undefined;
    const measured = measuredFileCounts({
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    });
    if (!measured) return undefined;
    additions += measured.additions;
    deletions += measured.deletions;
  }
  if (additions === 0 && deletions === 0) return undefined;
  return { additions, deletions };
}

/**
 * The live tail of a stretch: its newest calls, and how many scrolled out of
 * view above them. The in-flight call is always the newest, so it is never the
 * one hidden.
 */
export function liveWindow<T>(
  steps: T[],
  max = 4,
): { visible: T[]; hiddenCount: number } {
  const hiddenCount = Math.max(0, steps.length - max);
  return { visible: steps.slice(hiddenCount), hiddenCount };
}

/**
 * The wording for one exact call inside a stretch: the verb, then the thing it
 * ran on — "Ran git remote -v", "Read src/app.ts".
 *
 * `runRowText` names a call by what it was for ("Ran tests"), which is right
 * for a standalone row. Under a summary that already says "Ran 3 commands" the
 * purpose is implied, and the concrete command is what someone expanded the
 * line to see.
 */
export function runCallText(
  step: Extract<RunStep, { kind: "work" }>,
): RunRowText {
  const item = step.item;
  const running = item.status === "running";
  if (item.status === "failed" && (item.kind === "read" || item.kind === "search")) {
    if (item.kind === "search" && item.errorCode === "invalid-search-scope") {
      return { label: "Search path not found", description: item.path };
    }
    return {
      label: item.kind === "read" ? "Read failed" : "Search failed",
      description: item.kind === "read" ? item.path : item.query ?? item.path,
    };
  }
  switch (item.kind) {
    case "command":
      return {
        label: running ? "Running" : "Ran",
        description: displayCommand(item.command),
      };
    case "file":
      return {
        label: fileChangeVerb(item.lifecycle, running ? "running" : "done", true),
        description: item.path,
      };
    case "read": {
      const target = readTarget(item.path);
      const image = item.media === "image";
      const verb = image
        ? running
          ? "Viewing"
          : "Viewed"
        : running
          ? "Reading"
          : "Read";
      return target
        ? { label: verb, description: target }
        : { label: `${verb} ${image ? "image" : "file"}` };
    }
    case "search": {
      const verb = running ? "Searching" : "Searched";
      if (!item.query) {
        return {
          label: `${verb} ${item.scope === "web" ? "the web" : "project"}`,
        };
      }
      return {
        label: item.scope === "web" ? `${verb} the web for` : `${verb} for`,
        description: item.query,
      };
    }
    case "tool":
    case "memory":
    case "context":
    case "browser":
      return runRowText(step);
  }
}

/**
 * The command as typed, without the shell wrapper and `cd` preamble providers
 * put around it: `/bin/zsh -lc 'cd /repo && git status'` → `git status`.
 */
function displayCommand(command: string): string {
  const wrapped =
    /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  const inner = wrapped ? wrapped[2]! : command;
  return (
    inner.replace(/^\s*(?:cd\s+[^;&|]+\s*(?:&&|;)\s*)+/i, "").trim() || inner
  );
}

function workGroupStatus(
  steps: Array<Extract<RunStep, { kind: "work" }>>,
): WorkStatus {
  if (steps.some((step) => step.item.status === "failed")) return "failed";
  if (steps.some((step) => step.item.status === "running")) return "running";
  return "done";
}

function workGroupKind(item: WorkItem): WorkGroupKind {
  switch (item.kind) {
    case "file":
    case "memory":
      return "change";
    case "command":
      if (item.category === "test" || item.category === "build")
        return "verify";
      return item.category === "inspect" ? "review" : "command";
    case "browser":
      // Page work is its own phase; filing it under "Reviewed workspace" read
      // as if the agent had been browsing code.
      return "browser";
    case "tool": {
      const label = `${item.tool} ${item.note ?? ""}`.toLowerCase();
      if (/(?:edit|write|update|apply|propos)/.test(label)) return "change";
      if (/(?:test|build|check|diff|preview|screenshot)/.test(label)) {
        return "verify";
      }
      if (/(?:terminal|task|command|execute)/.test(label)) return "command";
      return "review";
    }
    case "read":
    case "search":
    case "context":
      return "review";
  }
}

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
      retryNotBefore?: number;
    }
  | { name: "interrupted" };

/** A file the run touched, available while it is still running. */
export type FileChange = {
  path: string;
  status: WorkStatus;
  additions?: number;
  deletions?: number;
  /** The agent's own note about this edit, when it left one. */
  intent?: string;
};

export type RunModel = {
  phase: RunPhase;
  startedAt: string;
  steps: RunStep[];
  files: FileChange[];
  response?: SessionEvent;
  /**
   * Set once a live run has gone quiet for long enough to say so. A run with no
   * output for minutes is alive but not obviously progressing, and a steadily
   * breathing "Thinking" would claim more than Gyro knows.
   */
  quietForSeconds?: number;
};

/** A settled work turn must visibly explain an absent closing reply.
 * This is recovery UI, never an invented assistant answer or a tool replay. */
export function runNeedsFinalResponse(
  model: RunModel,
  completionConfirmed = false,
): boolean {
  return (
    model.phase.name === "done" &&
    !model.response?.message.trim() &&
    (completionConfirmed ||
      model.files.length > 0 ||
      model.steps.some((step) => step.kind === "work"))
  );
}

/** Provider status for the turn, already parsed by the caller. */
export type RunStatusInput = {
  status: string;
  message?: string;
  error?: string;
  recoveryKind?: string;
  recoveryMessage?: string;
  retryNotBefore?: number;
  /** When this status was last refreshed. A heartbeat moves it forward. */
  at?: string;
  /** How long the backend has heard nothing from a run that is still alive. */
  quietForSeconds?: number;
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
    expandAssistantMessageSegments(reconcileCapabilityCalls(events)),
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
    const reasoning = reasoningTextFromEvent(event);
    if (reasoning) {
      // A replayed or re-sent summary is the same beat, not a second one.
      const previous = steps.at(-1);
      if (
        previous?.kind === "status" &&
        (previous.id === event.id || previous.text === reasoning)
      ) {
        continue;
      }
      steps.push({
        kind: "status",
        id: event.id,
        at: event.createdAt,
        text: reasoning,
      });
      continue;
    }
    const commentary = commentaryTextFromEvent(event);
    if (commentary) {
      if (!isOrphanAssistantFragment(commentary)) {
        steps.push({
          kind: "say",
          id: event.id,
          at: event.createdAt,
          text: commentary,
        });
      }
      continue;
    }
    const item = workItemFromEvent(event);
    if (item) {
      if (item.kind === "file" && !item.lifecycle) {
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
  // say steps so they stay under the work summary instead of the response body.
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

  // Guarded mutations record exact per-operation counts before writing. These
  // survive reloads and take precedence over duplicate provider/capability rows.
  // The same numbers go on the file row, so the working-process line can show
  // `+26 -9` instead of a bare path.
  for (const [path, counts] of appliedFileChangeCounts(events)) {
    const existing = files.find((file) => file.path === path);
    if (existing) {
      Object.assign(existing, counts);
    } else {
      files.push({ path, ...counts, status: "done" });
    }
    for (const step of steps) {
      if (
        step.kind === "work" &&
        step.item.kind === "file" &&
        step.item.path === path
      ) {
        step.item.additions = counts.additions;
        step.item.deletions = counts.deletions;
      }
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
    quietForSeconds: runQuietSeconds(settledSteps, options),
  };
}

function runQuietSeconds(steps: RunStep[], options: BuildRunModelOptions) {
  const quietFor = options.status?.quietForSeconds;
  if (!options.isRunning || !quietFor) {
    return undefined;
  }
  // Heartbeats arrive every 20 seconds, so a step can land between them. That
  // step already disproves the note, and it should not linger until the next one.
  const heardAt = Date.parse(options.status?.at ?? "");
  return steps.some((step) => Date.parse(step.at) > heardAt)
    ? undefined
    : quietFor;
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
      !(previous.item.status !== "running" && step.item.status === "running") &&
      previous.item.status !== "failed" && step.item.status !== "failed" &&
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
  if (item.historicalDetail !== undefined) {
    return `historical:${item.historicalCallId ?? item.id}`;
  }
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
  // A saved provider response is the conclusion even when late capability
  // events or live sequence numbers place work after it. Move only its closing
  // blocks, without promoting commentary or a previous attempt's answer.
  const durable = events.findLast(isDurableAssistantResponse);
  if (durable) {
    const responseId = durable.id.split("#segment-")[0];
    const belongsToResponse = (event: SessionEvent) =>
      isDurableAssistantResponse(event) &&
      event.id.split("#segment-")[0] === responseId &&
      event.sessionId === durable.sessionId &&
      event.turnId === durable.turnId;
    // A block the saved reply placed before later work was spoken mid-run.
    // Dragging it down beside the answer made it read as the answer's opening
    // whenever the preamble wording check missed it, so it keeps its place.
    const lastIndex = events.findLastIndex(belongsToResponse);
    let firstIndex = lastIndex;
    while (firstIndex > 0 && belongsToResponse(events[firstIndex - 1]!)) {
      firstIndex -= 1;
    }
    events = [
      ...events.slice(0, firstIndex),
      ...events.slice(lastIndex + 1),
      ...events.slice(firstIndex, lastIndex + 1),
    ];
  }
  let end = events.length;
  while (end > 0 && workItemFromEvent(events[end - 1]!)?.kind === "file") {
    end -= 1;
  }

  const trailing: SessionEvent[] = [];
  let index = end - 1;
  while (
    index >= 0 &&
    events[index]!.kind === "assistant-message" &&
    (!durable ||
      events[index]!.id.split("#segment-")[0] ===
        durable.id.split("#segment-")[0])
  ) {
    const text = events[index]!.message.trim();
    if (
      text &&
      (isDurableAssistantResponse(events[index]!) ||
        !isOrphanAssistantFragment(text))
    ) {
      trailing.unshift(events[index]!);
    }
    index -= 1;
  }
  if (trailing.length === 0) {
    return undefined;
  }

  const before = events.slice(0, index + 1);
  // A reasoning headline is not work: an answer that only follows the model
  // thinking is still the opening line of a live run.
  const followsWork = before.some(
    (event) =>
      event.kind !== "assistant-message" && !reasoningTextFromEvent(event),
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
 * a plan line, a status line, or a stray fragment. An empty non-durable message
 * counts, since what it held was dropped as noise. An empty durable reply does
 * not: a symbol or digit is still the answer.
 */
function isNarrationOnly(event: SessionEvent): boolean {
  const blocks = structuredCommentaryBlocks(event.message);
  // A durable stamp means the provider saved the reply, not that this sentence
  // is the answer. While the run is live, a reply that only promises the next
  // step still belongs on the rail. A symbol or digit that commentary
  // stripping drops is still an answer, so an empty durable block is not
  // narration.
  if (blocks.length === 0) {
    return !isDurableAssistantResponse(event);
  }
  return blocks.every(isAssistantPreambleBlock);
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
  const message = isDurableAssistantResponse(event)
    ? finalAssistantResponseText(event.message)
    : structuredCommentaryBlocks(event.message).join("\n\n");
  return message === event.message ? event : { ...event, message };
}

/**
 * One failed-turn paragraph.
 *
 * Recovery is extra advice. Skip it when the error already contains that
 * sentence, and when both already tell the person to unlock the Mac and send
 * again. Those two Keychain lines differ by a few words, so a plain inclusion
 * check still leaves the instruction on screen twice.
 */
export function failureDetail(message: string, recovery?: string) {
  const problem = message.trim();
  const advice = recovery?.trim() ?? "";
  if (!advice) return problem;
  if (!problem) return advice;
  const problemText = problem.toLowerCase();
  const adviceText = advice.toLowerCase();
  if (problemText.includes(adviceText)) return problem;
  if (asksToUnlockAndResend(problemText) && asksToUnlockAndResend(adviceText)) {
    return problem;
  }
  return `${problem} ${advice}`;
}

function asksToUnlockAndResend(text: string) {
  return text.includes("unlock your mac") && text.includes("send again");
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
    if (steps.length === 0 || steps.every((step) => step.kind === "status")) {
      return { name: "thinking" };
    }
    return response ? { name: "finalizing" } : { name: "working" };
  }
  if (status && PROBLEM_STATUSES.includes(status.status)) {
    const cancelled = status.status === "cancelled";
    // Older saved failures classified Codex quota refusals as generic retries.
    const quotaExceeded = !cancelled && isProviderQuotaError(status.error ?? "");
    return {
      name: "failed",
      message: cancelled
        ? status.message?.trim() || "Stopped"
        : status.error?.trim() || status.message || "The run stopped early",
      // Normalize so the header and problem tone can tell user-stop from crash.
      recoveryKind: cancelled ? "cancelled" : quotaExceeded ? "quota-exceeded" : status.recoveryKind,
      recoveryMessage: quotaExceeded ? PROVIDER_QUOTA_RECOVERY : status.recoveryMessage,
      ...(status.retryNotBefore !== undefined ? { retryNotBefore: status.retryNotBefore } : {}),
    };
  }
  return { name: "done", durationMs: options.durationMs };
}

function classifyCommandActivity({
  command,
  id,
  intent,
  status,
  error,
}: {
  command: string;
  id: string;
  intent?: string;
  status: WorkStatus;
  error?: string;
}): WorkItem {
  const shape = parseShellCommand(displayCommand(command));
  const words = withoutEnvAssignments(shape.segments[0] ?? []);
  const program = words[0];
  // The row's verb promises what happened. `rg foo && rm -rf dist` and
  // `sed -i ...` both start like a lookup, and calling them "Searched" or "Read"
  // would hide a change, so anything beyond a lookup stays a plain command.
  const onlyLooks = shellOnlyLooks(shape);
  if (onlyLooks && (program === "rg" || program === "grep")) {
    return {
      kind: "search",
      id,
      status,
      scope: "project",
      query: commandSearchQuery(words),
      ...(error ? { error } : {}),
    };
  }
  if (
    onlyLooks &&
    program &&
    READ_PROGRAMS.has(program) &&
    !editsInPlace(words)
  ) {
    const path = commandFileTarget(words);
    return {
      kind: "read",
      id,
      status,
      path,
      media: isImagePath(path) ? "image" : "file",
      ...(error ? { error } : {}),
    };
  }
  const programs = shape.segments.map((segment) =>
    withoutEnvAssignments(segment).join(" "),
  );
  const category: CommandCategory | undefined = programs.some((text) =>
    TEST_COMMAND.some((pattern) => pattern.test(text)),
  )
    ? "test"
    : programs.some((text) =>
          BUILD_COMMAND.some((pattern) => pattern.test(text)),
        )
      ? "build"
      : onlyLooks && INSPECT_COMMAND.test(programs[0] ?? "")
        ? "inspect"
        : undefined;
  return { kind: "command", id, status, command, intent, category, ...(error ? { error } : {}) };
}

const READ_PROGRAMS = new Set(["sed", "head", "tail", "cat", "awk"]);
/** Downstream of a pipe, these only narrow what is already being looked at. */
const PIPE_FILTERS = new Set([
  "awk",
  "column",
  "cut",
  "egrep",
  "fgrep",
  "grep",
  "head",
  "jq",
  "less",
  "more",
  "nl",
  "rg",
  "sed",
  "sort",
  "tail",
  "tr",
  "uniq",
  "wc",
]);
/** Runners and the flags that can sit before their script: `pnpm -r test`. */
const PACKAGE_SCRIPT =
  "^(?:pnpm|npm|yarn|bun)(?:\\s+-\\S+(?:\\s+(?!run\\b|test\\b|build\\b|-)\\S+)?)*\\s+(?:run\\s+)?";
const TOOL_RUNNER = "^(?:(?:npx|bunx|pnpm\\s+exec|python3?\\s+-m)\\s+)?";
const TEST_COMMAND = [
  new RegExp(`${PACKAGE_SCRIPT}(?:test\\b|t(?:\\s|$))`),
  new RegExp(
    `${TOOL_RUNNER}(?:vitest|jest|mocha|pytest|playwright\\s+test)\\b`,
  ),
  /^cargo(?:\s+\+\S+)?\s+(?:test|nextest)\b/,
  /^(?:go|swift|deno)\s+test\b/,
  /^make(?:\s+-\S+)*\s+test\b/,
  /^node\s+--test\b/,
];
const BUILD_COMMAND = [
  new RegExp(`${PACKAGE_SCRIPT}build\\b`),
  // `tsc --noEmit` is a typecheck. It builds nothing, so it should not read as one.
  new RegExp(
    `${TOOL_RUNNER}(?:tsc\\b(?!.*--noEmit)|(?:vite|next)\\s+build\\b)`,
  ),
  /^cargo(?:\s+\+\S+)?\s+build\b/,
  /^(?:go|swift)\s+build\b/,
  /^make(?:\s+-\S+)*\s+build\b/,
];
const INSPECT_COMMAND =
  /^(?:git(?:\s+-C\s+\S+)?\s+(?:status|diff|log|show)\b|git\s+branch(?:\s+(?:-a|-r|-v|-vv|--all|--list|--remotes|--show-current))*$|ls\b|pwd\b|find\b(?!.*\s-(?:delete|exec|execdir|ok|okdir|fprint\S*|fls)\b))/;

type ShellShape = {
  /** The words of each simple command, with quotes and redirects removed. */
  segments: string[][];
  /** The operator joining each segment to the next one. */
  joins: string[];
  /** Whether any output is redirected somewhere that keeps it. */
  writesFile: boolean;
};

/**
 * Just enough shell to see a command's structure.
 *
 * Quote-aware because a pattern routinely holds the operators this looks for:
 * `rg "a|b"` is one search, not a pipeline. Anything it does not understand
 * ends up looking chained, and a chained command stays a plain command row.
 */
function parseShellCommand(command: string): ShellShape {
  const segments: string[][] = [[]];
  const joins: string[] = [];
  let writesFile = false;
  let word: string | undefined;
  let quote: string | undefined;
  let redirect: "input" | "output" | undefined;
  const endWord = () => {
    if (word === undefined) {
      return;
    }
    if (redirect === "output" && !HARMLESS_REDIRECT.test(word)) {
      writesFile = true;
    }
    if (!redirect) {
      segments.at(-1)!.push(word);
    }
    redirect = undefined;
    word = undefined;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index]!;
      } else {
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\") {
      index += 1;
      if (command[index] !== "\n") {
        word = (word ?? "") + (command[index] ?? "");
      }
    } else if (char === ">") {
      // The digits in `2>` name a stream. They are not an argument.
      if (word !== undefined && /^\d+$/.test(word)) {
        word = undefined;
      }
      endWord();
      redirect = "output";
      if (command[index + 1] === ">") {
        index += 1;
      }
      if (command[index + 1] === "&") {
        index += 1;
        word = "&";
      }
    } else if (char === "<") {
      endWord();
      redirect = "input";
      while (command[index + 1] === "<") {
        index += 1;
      }
    } else if (char === ";" || char === "\n" || char === "&" || char === "|") {
      endWord();
      redirect = undefined;
      const next = command[index + 1];
      const doubled = next === char && (char === "&" || char === "|");
      const isPipeAll = char === "|" && next === "&";
      if (doubled || isPipeAll) {
        index += 1;
      }
      if (segments.at(-1)!.length > 0) {
        joins.push(doubled ? char + char : char);
        segments.push([]);
      }
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }
  endWord();
  if (segments.length > 1 && segments.at(-1)!.length === 0) {
    segments.pop();
    joins.pop();
  }
  return { segments, joins, writesFile };
}

/** Moving output to a stream or discarding it keeps nothing. */
const HARMLESS_REDIRECT = /^(?:&\d*-?|\/dev\/(?:null|stdout|stderr))$/;

function shellOnlyLooks(shape: ShellShape) {
  return (
    !shape.writesFile &&
    shape.joins.every((join, index) => {
      const next = withoutEnvAssignments(shape.segments[index + 1] ?? []);
      if (join === "|") {
        return PIPE_FILTERS.has(next[0] ?? "") && !editsInPlace(next);
      }
      // `rg foo || true` only quiets an exit code.
      return join === "||" && /^(?:true|:|echo)$/.test(next[0] ?? "");
    })
  );
}

function withoutEnvAssignments(words: string[]) {
  const first = words.findIndex((word) => !/^\w+=/.test(word));
  return first < 0 ? [] : words.slice(first);
}

function editsInPlace(words: string[]) {
  if (words[0] === "sed") {
    return words.some(
      (word) => /^-[a-zA-Z]*i/.test(word) || word.startsWith("--in-place"),
    );
  }
  return words[0] === "awk" && words.includes("inplace");
}

/** Search flags whose next word is their value and not the pattern. */
const SEARCH_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-f",
  "-g",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--context",
  "--file",
  "--glob",
  "--max-count",
  "--type",
  "--type-not",
]);

function commandSearchQuery(words: string[]) {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--" || word === "-e" || word === "--regexp") {
      return (words[index + 1] ?? "").slice(0, 160);
    }
    if (word.startsWith("--regexp=")) {
      return word.slice("--regexp=".length, 160 + "--regexp=".length);
    }
    if (SEARCH_VALUE_FLAGS.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      return word.slice(0, 160);
    }
  }
  return "";
}

function commandFileTarget(words: string[]) {
  const candidate = words.at(-1);
  if (words.length < 2 || !candidate || candidate.startsWith("-")) {
    return undefined;
  }
  // `sed` and `awk` take a script first, so a lone argument is the script
  // reading from a pipe and there is no file to name.
  const hasFile =
    (words[0] !== "sed" && words[0] !== "awk") ||
    words.slice(1).filter((word) => !word.startsWith("-")).length > 1;
  return hasFile ? candidate : undefined;
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

  // Imported calls are a record of past work. Keep their output inspectable,
  // without classifying a past edit, command, or browser action as current work.
  if (payload?.historical === true) {
    return {
      kind: "tool",
      id,
      status: status === "failed" ? "failed" : "done",
      ...splitToolName(text(payload, "tool") ?? label),
      note: text(payload, "note"),
      historicalDetail: detail ?? "",
      historicalCallId: text(payload, "sourceCallId") ?? id,
    };
  }

  switch (text(payload, "activityKind")) {
    case "command":
      return classifyCommandActivity({
        command: text(payload, "command") ?? detail ?? label,
        id,
        intent: text(payload, "intent") ?? (status === "failed" ? undefined : text(payload, "note")),
        error: status === "failed" ? text(payload, "error") ?? text(payload, "note") : undefined,
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
        intent: text(payload, "intent") ?? text(payload, "note"),
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
      return {
        kind: "context",
        id,
        status,
        compaction: compactionModeFromPayload(payload),
      };
    case "commentary":
      // Commentary is prose, not work. It reaches the rail as a `say` step via
      // the assistant-message path, so it must not become a row here.
      return undefined;
    case "reasoning":
      // A reasoning headline becomes a `status` step, never a tool row.
      return undefined;
    case "tool": {
      const raw = text(payload, "tool") ?? detail ?? label;
      // A provider calling Gyro's browser directly is still a browser beat.
      const browserTool = /(?:^|__)gyro_browser_([a-z_]+)$/i.exec(raw.trim());
      if (browserTool) {
        const note = text(payload, "note");
        return {
          kind: "browser",
          id,
          status,
          action: browserActionFromName(browserTool[1]!.toLowerCase()),
          target:
            note && /^https?:\/\//i.test(note)
              ? browserPageLabel(note)
              : undefined,
        };
      }
      return {
        kind: "tool",
        id,
        status,
        ...splitToolName(raw),
        note: text(payload, "note"),
      };
    }
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
    case "create":
    case "edit":
    case "delete":
    case "move":
      return {
        kind: "file",
        id,
        status,
        path: text(payload, "path") ?? detail ?? stripUpdatedPrefix(label),
        additions: count(payload, "additions"),
        deletions: count(payload, "deletions"),
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

/** Provider commentary is user-facing narration, not a generic system event. */
function commentaryTextFromEvent(event: SessionEvent): string | undefined {
  if (event.kind !== "system-event") return undefined;
  const payload = record(event.payload);
  if (
    text(payload, "kind") !== "provider-activity" ||
    text(payload, "activityKind") !== "commentary"
  ) {
    return undefined;
  }
  return (
    stripHiddenControlMarkers(text(payload, "label") ?? event.message).trim() ||
    undefined
  );
}

/** The headline of a provider reasoning summary, when this event carries one. */
function reasoningTextFromEvent(event: SessionEvent): string | undefined {
  if (event.kind !== "system-event") return undefined;
  const payload = record(event.payload);
  if (
    text(payload, "kind") !== "provider-activity" ||
    text(payload, "activityKind") !== "reasoning"
  ) {
    return undefined;
  }
  return (
    (text(payload, "label") ?? event.message).replace(/\*\*/g, "").trim() ||
    undefined
  );
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
  // Workflow children remain inspectable inside their parent card, without flooding the live rail.
  if (text(payload, "groupId")) return undefined;
  const id = event.id;
  const status = capabilityWorkStatus(text(payload, "status"));
  const summary = text(payload, "summary");
  const resource = record(payload?.resource);
  const resourceLabel = text(resource, "label");
  const inspection = record(payload?.inspection);
  const ui = capabilityUi(capabilityId);
  const label = ui?.label ?? capabilityLabel(capabilityId);
  const path = text(inspection, "path") ?? resourceLabel ?? (status === "failed" ? undefined : summary);
  const lifecycle = pathLifecycleForCapability(capabilityId);
  // A finished create, rename, move, trash, or duplicate is a path card.
  // A failed call changed nothing, so it stays a plain beat.
  if (lifecycle && resourceLabel && status !== "failed") {
    return { kind: "file", id, status, path: resourceLabel, lifecycle };
  }
  if (
    capabilityId === "code-mode-execute" ||
    capabilityId === "code-mode-discover"
  ) {
    const workflow = record(payload?.codeMode);
    return {
      kind: "tool",
      id,
      status,
      tool: text(workflow, "label") ?? label,
      note: summary,
    };
  }

  // Record the launch where it happened; ongoing child state belongs to the
  // sub-agent strip and Environment rather than the parent's work timeline.
  if (capabilityId === "agent-spawn") {
    return {
      kind: "tool",
      id,
      status,
      tool:
        status === "running"
          ? "Starting sub-agent"
          : status === "failed"
            ? "Could not start sub-agent"
            : "Started sub-agent",
      note: resourceLabel,
    };
  }

  switch (ui?.row) {
    // Terminal-shaped work → command row (matches "Ran command").
    case "command":
      return classifyCommandActivity({
        command: summary ?? resourceLabel ?? label,
        id,
        intent: summary,
        error: status === "failed" ? summary : undefined,
        status,
      });

    // Project search → search row.
    case "search":
      return {
        kind: "search",
        id,
        status,
        scope: ui?.scope ?? "project",
        query: text(inspection, "query") ?? (status === "failed" ? undefined : summary ?? resourceLabel),
        path: text(inspection, "path"),
        error: status === "failed" ? summary : undefined,
        errorCode: text(inspection, "errorCode"),
      };

    // Reading a workspace file is the same beat as a provider read, so it gets
    // the same row rather than a generic wrench.
    case "read":
      return {
        kind: "read",
        id,
        status,
        path,
        media: isImagePath(path) ? "image" : "file",
        error: status === "failed" ? summary : undefined,
      };

    // Gyro's own edit and lifecycle tools change a file just like a provider
    // edit does. The path only arrives on the completed call, and a failed call
    // changed nothing, so it falls through to a plain beat.
    case "file":
      if (resourceLabel && status !== "failed") {
        return { kind: "file", id, status, path: resourceLabel };
      }
      break;

    case "browser": {
      const action = ui?.action;
      if (action) {
        return {
          kind: "browser",
          id,
          status,
          action,
          target:
            text(payload, "target") ??
            (resourceLabel ? browserPageLabel(resourceLabel) : undefined),
        };
      }
      break;
    }
  }

  // Everything else is a single tool beat with the table's own title.
  return { kind: "tool", id, status, tool: label, ...(status === "failed" && summary ? { error: summary } : {}) };
}

function pathLifecycleForCapability(
  capabilityId: string,
): FileLifecycle | undefined {
  switch (capabilityId) {
    case "workspace-create-path":
      return "create";
    case "workspace-rename-path":
      return "rename";
    case "workspace-move-path":
      return "move";
    case "workspace-delete-path":
      return "trash";
    case "workspace-duplicate-path":
      return "duplicate";
    default:
      return undefined;
  }
}

function capabilityWorkStatus(value: string | undefined): WorkStatus {
  if (value === "requested" || value === "waiting" || value === "running") {
    return "running";
  }
  if (value === "failed" || value === "denied" || value === "cancelled") {
    return "failed";
  }
  return "done";
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
    // The clock is still honest here — the turn never ended — and its compact
    // placement keeps the activity itself as the header's main message.
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
/**
 * The compaction outcome recorded on a provider activity event.
 *
 * Older events carry no marker: only the local transcript rewrite wrote a
 * checkpoint summary, so its presence identifies those as condensed.
 */
function compactionModeFromPayload(
  payload: Record<string, unknown> | undefined,
): "summarized" | "condensed" | "kept" | undefined {
  const mode = text(payload, "compactionMode");
  if (mode === "summarized" || mode === "condensed" || mode === "kept") {
    return mode;
  }
  return text(payload, "contextSummary") ? "condensed" : undefined;
}

export function runRowText(step: RunStep): RunRowText {
  if (step.kind === "say" || step.kind === "status") {
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
      return {
        label: fileChangeVerb(item.lifecycle, item.status, false),
        description: item.path,
      };
    case "read":
      return {
        label: readVerb(item.status, item.media),
        description: readTarget(item.path),
      };
    case "search":
      return {
        label:
          item.status === "failed" ? "Search failed" : item.status === "running"
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
    case "context": {
      // Codex compacts inside its own session; every other provider spends one
      // real summarization call. Only a failed call falls back to the local
      // digest, and the stored mode already says which of the two happened.
      const described =
        item.compaction === "condensed"
          ? "Earlier turns condensed into a digest"
          : item.compaction === "kept"
            ? "History already fit; nothing dropped"
            : item.compaction === "summarized"
              ? "Earlier conversation summarized"
              : undefined;
      return {
        label:
          item.status === "running"
            ? "Compacting context"
            : "Compacted context",
        description:
          item.status === "running"
            ? "Summarizing the earlier conversation"
            : described,
      };
    }
    case "browser": {
      const [running, done] = BROWSER_ROW_LABELS[item.action];
      return {
        label: item.status === "running" ? running : done,
        description: item.target,
      };
    }
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
        return withNote(item.status === "running" ? "Using tool" : "Used tool");
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
      return withNote(item.status === "running" ? "Using tool" : "Used tool");
    }
  }
}

function commandVerb(category: CommandCategory | undefined, running: boolean) {
  if (category === "inspect")
    return running ? "Inspecting workspace" : "Inspected workspace";
  if (category === "test") return running ? "Running tests" : "Ran tests";
  if (category === "build")
    return running ? "Building project" : "Built project";
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
    "workspace check": "Checking workspace",
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

/**
 * Wording for a file row.
 *
 * Content edits keep the long form ("Edited file") the rail already uses.
 * A path change names the lifecycle ("Moved") because Undo reverses that
 * journal entry, not the editor buffer. `short` drops the trailing "file"
 * for a call nested under a summary that already counted the files.
 */
export function fileChangeVerb(
  lifecycle: FileLifecycle | undefined,
  status: WorkStatus,
  short: boolean,
): string {
  if (!lifecycle) {
    if (status === "running") return short ? "Editing" : "Editing file";
    if (short) return status === "failed" ? "Edit failed" : "Edited";
    return status === "failed" ? "Edit failed" : "Edited file";
  }
  if (status === "failed") {
    const name = {
      create: "create",
      rename: "rename",
      move: "move",
      trash: "trash",
      duplicate: "duplicate",
    }[lifecycle];
    return `Could not ${name}`;
  }
  const done = status !== "running";
  const verb = {
    create: done ? "Created" : "Creating",
    rename: done ? "Renamed" : "Renaming",
    move: done ? "Moved" : "Moving",
    trash: done ? "Trashed" : "Trashing",
    duplicate: done ? "Duplicated" : "Duplicating",
  }[lifecycle];
  return short ? verb : `${verb} file`;
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
      server: humanizeToolSegment(
        server.replace(/^gyro_capabilities$/i, "gyro"),
      ),
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

const BROWSER_ACTIONS: Record<string, BrowserAction> = {
  targets: "targets",
  "select-target": "select-target", select_target: "select-target",
  "capture-preview": "capture-preview", capture_preview: "capture-preview",
  "preview-click": "preview-click", preview_click: "preview-click",
  open: "open",
  navigate: "navigate",
  back: "back",
  forward: "forward",
  reload: "reload",
  inspect: "inspect",
  "read-page": "read",
  read_page: "read",
  find: "find",
  console: "console",
  network: "network",
  screenshot: "capture",
  viewport: "viewport",
  "set-viewport": "viewport",
  set_viewport: "viewport",
  mouse: "mouse",
  click: "click",
  type: "type",
  scroll: "scroll",
  "form-input": "form",
  form_input: "form",
};

const BROWSER_ROW_LABELS: Record<BrowserAction, [string, string]> = {
  targets: ["Finding preview targets", "Found preview targets"],
  "select-target": ["Selecting preview target", "Selected preview target"],
  "capture-preview": ["Capturing app preview", "Captured app preview"],
  "preview-click": ["Clicking app preview", "Clicked app preview"],
  open: ["Opening page", "Opened page"],
  navigate: ["Navigating", "Navigated"],
  back: ["Going back", "Went back"],
  forward: ["Going forward", "Went forward"],
  reload: ["Reloading page", "Reloaded page"],
  inspect: ["Inspecting browser", "Inspected browser"],
  read: ["Reading page", "Read page"],
  find: ["Finding on page", "Found on page"],
  console: ["Reading console", "Read console"],
  network: ["Reading network", "Read network"],
  capture: ["Capturing page", "Captured page"],
  viewport: ["Resizing viewport", "Resized viewport"],
  mouse: ["Using browser mouse", "Used browser mouse"],
  click: ["Clicking", "Clicked"],
  type: ["Typing", "Typed"],
  scroll: ["Scrolling", "Scrolled page"],
  form: ["Filling field", "Filled field"],
};

/**
 * Wording for a live browser capability call, so the Browser panel's presence
 * strip says exactly what the rail row says.
 */
export function browserCapabilityText(
  capabilityId: string,
  status: string,
  target?: string,
): { label: string; description?: string } {
  const action = capabilityUi(capabilityId)?.action;
  if (!action) {
    // Not a browser verb: name the capability instead of reporting an
    // inspection that never happened.
    return { label: capabilityLabel(capabilityId), description: target };
  }
  const [running, done] = BROWSER_ROW_LABELS[action];
  return {
    label: status === "completed" ? done : running,
    description: target,
  };
}

/** `read-page` / `read_page` → `read`; an unknown verb reads as an inspection. */
function browserActionFromName(name: string): BrowserAction {
  return BROWSER_ACTIONS[name] ?? "inspect";
}

/** `http://127.0.0.1:1437/chat.html?x=1` → `127.0.0.1:1437/chat.html` */
function browserPageLabel(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return url.host ? `${url.host}${path}` : value;
  } catch {
    return value;
  }
}

/** `gyro_workspace_get_context` → `Workspace context` */
function humanizeCapabilityTool(value: string): string {
  let name = value.trim();
  name = name.replace(/^(?:gyro_capabilities__|mcp__gyro_capabilities__)/i, "");
  name = name.replace(/^gyro_/i, "");
  // Known short labels for the tools users see every turn.
  const known: Record<string, string> = {
    workspace_get_context: "Workspace context",
    terminal_wait: "Wait for command",
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
function absorbRepeatedWork(
  steps: RunStep[],
  item: WorkItem,
): boolean {
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
  // A failed attempt is evidence, even if an identical later attempt succeeds.
  // Invocation lifecycle updates are already reconciled before display folding.
  if (target.item.status === "failed" || item.status === "failed") {
    return false;
  }
  // Finished rows never regain a spinner. A new invocation gets a new row
  // and its own clock, even when it repeats the same tool or path.
  if (item.status === "running" && target.item.status !== "running") {
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
      return item.lifecycle
        ? `file:${item.lifecycle}:${item.path}`
        : `file:${item.path}`;
    case "read":
      return item.path ? `read:${item.media}:${item.path}` : undefined;
    case "command":
      return `command:${item.command}`;
    case "search":
      return item.query ? `search:${item.scope}:${item.query}` : undefined;
    case "browser":
      return item.target ? `browser:${item.action}:${item.target}` : undefined;
    case "tool":
      if (item.historicalDetail !== undefined) {
        return `tool:historical:${item.historicalCallId ?? item.id}`;
      }
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
      // Only when the agent actually left a note — an empty key would read as a
      // note that says nothing.
      ...(item.intent ? { intent: item.intent } : {}),
    });
    return;
  }
  existing.status = item.status;
  existing.additions = item.additions ?? existing.additions;
  existing.deletions = item.deletions ?? existing.deletions;
  // The first note explains the edit; later touches of the same file are
  // usually follow-ups, so an existing note is not overwritten by a vaguer one.
  if (!existing.intent && item.intent) existing.intent = item.intent;
}

/** Control markers are instructions to the app, never beats in the run. */
function isHiddenRunEvent(event: SessionEvent) {
  // Applied receipts feed file totals, not extra work or approval cards.
  if (isAppliedFileMutationEvent(event)) {
    return true;
  }
  if (event.kind !== "system-event") {
    return false;
  }
  const payload = record(event.payload);
  if (text(payload, "kind") === "subagent-state") return true;
  // A "Kept" is the user's reading record, not something the run did. Without
  // this it would fall through to the unrecognized-event branch and draw as an
  // approval row the agent never asked for.
  if (text(payload, "schema") === FILE_REVIEW_SCHEMA) {
    return true;
  }
  if (text(payload, "kind") !== "provider-activity") {
    return false;
  }
  // A stray marker is stripped from the note, not a reason to hide it; only a
  // label that held nothing but markers disappears.
  const label = text(payload, "label") ?? event.message;
  return (
    (label.includes("GYRO_SESSION_TITLE:") ||
      label.includes("GYRO_ARTIFACTS:") ||
      label.includes("GYRO_QUESTIONS:") ||
      label.includes("GYRO_TASKS:") ||
      label.includes("GYRO_MEMORY:") ||
      label.includes("GYRO_AGENT_UPDATE:")) &&
    !stripHiddenControlMarkers(label).trim()
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
