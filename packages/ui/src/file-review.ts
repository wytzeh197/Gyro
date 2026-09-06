/**
 * End-of-turn file review.
 *
 * In "Ask first" the agent asks before every edit, so by the time a turn ends
 * its changes are already on disk. The review card is therefore a reading pass,
 * not an apply gate: keeping a file records that the user read it, and a file
 * nobody marks is unread rather than pending, rejected, or withheld. Nothing
 * here applies or reverts anything.
 *
 * Everything the card shows has to be something that actually happened. A
 * summary is a sentence a model wrote about this exact diff, a note the agent
 * left while editing, or a count of the lines that moved — never prose invented
 * here to fill the row.
 */

import { workItemFromEvent } from "./chat-run.ts";
import { FILE_REVIEW_SCHEMA } from "./types.ts";
import type {
  FileReviewDecision,
  FileReviewSummary,
  FileReviewSummarySource,
  SessionEvent,
} from "./types.ts";

/** A changed file as the card receives it. */
export type FileReviewFile = {
  path: string;
  additions: number;
  deletions: number;
  /** What the agent said it was doing, when it said anything. */
  intent?: string;
};

export type FileReviewLine = {
  text: string;
  source: FileReviewSummarySource;
};

/**
 * The one line under a file name.
 *
 * Ranked by how much the source actually knows: a sentence bought for this
 * diff, then the agent's own note about the edit, then the measurement the
 * backend falls back to. The measurement is last because the row already shows
 * the same numbers as badges.
 */
export function changeSummaryLine(
  file: Pick<FileReviewFile, "intent">,
  summary?: FileReviewSummary,
): FileReviewLine | undefined {
  if (summary?.source === "provider" && summary.summary.trim()) {
    return { text: summary.summary.trim(), source: "provider" };
  }
  const intent = file.intent?.trim();
  if (intent) return { text: sentence(intent), source: "intent" };
  const fallback = summary?.summary.trim();
  if (fallback) return { text: fallback, source: "fallback" };
  return undefined;
}

function sentence(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export type FileReviewRecord = {
  decision: FileReviewDecision;
  /** The content the decision was made about, so a later edit retires it. */
  contentHash?: string;
  at: string;
};

/**
 * Replay the Keeps out of a turn's events.
 *
 * The decision lives in the session log rather than in component state, so it
 * survives a reload and reads the same way on a session reopened months later.
 */
export function fileReviewDecisions(
  events: SessionEvent[],
): Map<string, FileReviewRecord> {
  const decisions = new Map<string, FileReviewRecord>();
  for (const event of events) {
    if (event.kind !== "system-event") continue;
    const payload = record(event.payload);
    if (text(payload, "schema") !== FILE_REVIEW_SCHEMA) continue;
    const path = text(payload, "path");
    if (!path) continue;
    if (text(payload, "decision") !== "kept") continue;
    decisions.set(path, {
      decision: "kept",
      contentHash: text(payload, "contentHash"),
      at: event.createdAt,
    });
  }
  return decisions;
}

/**
 * Whether a recorded Keep still describes what is on disk.
 *
 * A Keep is about content, not about a file name: once the file changes again
 * the old reading is stale, and claiming it would tell the user they have seen
 * something they have not. An unknown current hash (summaries have not arrived
 * yet) leaves the last known answer standing rather than flickering.
 */
export function isKeptCurrent(
  entry: FileReviewRecord | undefined,
  contentHash: string | undefined,
) {
  if (!entry) return false;
  if (!contentHash || !entry.contentHash) return true;
  return entry.contentHash === contentHash;
}

export type DiffPreviewKind = "added" | "removed" | "hunk" | "meta" | "context";

export type DiffPreviewLine = { text: string; kind: DiffPreviewKind };

/**
 * Split a unified diff into rows the card can paint.
 *
 * Capped, because an inline preview inside a chat turn is a look, not the diff
 * viewer: past the cap the reader is sent to Changes instead of scrolling a
 * chat bubble.
 */
export function diffPreviewLines(
  diff: string,
  limit = 240,
): { lines: DiffPreviewLine[]; truncated: boolean } {
  const raw = diff.replace(/\r\n?/g, "\n").split("\n");
  while (raw.length && !raw[raw.length - 1]?.trim()) raw.pop();
  const lines: DiffPreviewLine[] = raw.slice(0, limit).map((text) => ({
    text,
    kind: diffLineKind(text),
  }));
  return { lines, truncated: raw.length > limit };
}

function diffLineKind(line: string): DiffPreviewKind {
  if (line.startsWith("@@")) return "hunk";
  // `+++`/`---` are file headers, not content, and are checked before the
  // single-character tests that would otherwise claim them.
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity index") ||
    line.startsWith("rename ") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("\\ No newline")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** What "Ask AI" puts in the composer. The user still presses send. */
export function askAboutFilePrompt(path: string) {
  return `About ${path}: `;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A turn's edited files, as the review card will list them. */
export type FileReviewTurn = {
  turnId: string;
  files: FileReviewFile[];
};

/**
 * The most recent turn that edited files.
 *
 * Only the newest card is worth a summary call: older turns in the transcript
 * were already described when they landed, and re-describing them on every
 * scroll would buy the same sentences twice.
 */
export function latestFileReviewTurn(
  events: SessionEvent[],
): FileReviewTurn | undefined {
  const byTurn = new Map<string, Map<string, FileReviewFile>>();
  let latestTurnId: string | undefined;
  for (const event of events) {
    const turnId = event.turnId;
    if (!turnId) continue;
    const item = workItemFromEvent(event);
    if (item?.kind !== "file") continue;
    const path = item.path?.trim();
    // The rail uses a bare "Files" row as a heading when the agent names no
    // path; there is nothing to review behind it.
    if (!path || path.toLowerCase() === "files") continue;
    let files = byTurn.get(turnId);
    if (!files) {
      files = new Map();
      byTurn.set(turnId, files);
    }
    files.set(path, {
      path,
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      intent: item.intent ?? files.get(path)?.intent,
    });
    latestTurnId = turnId;
  }
  if (!latestTurnId) return undefined;
  const files = byTurn.get(latestTurnId);
  if (!files?.size) return undefined;
  return { turnId: latestTurnId, files: [...files.values()] };
}
