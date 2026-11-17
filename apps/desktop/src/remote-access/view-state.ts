import { readBuffers, writeBuffers } from "./buffer-storage.ts";
import type { FileBuffer } from "./types";
export type PendingSubmit = {
  requestId: string;
  turnId: string;
  message: string;
  draft: string;
  attachmentIds?: string[];
  /** When the submit was issued. Missing on entries saved by older builds. */
  sentAt?: number;
};
/** How long a host may take to record a submit it has already received. */
export const PENDING_SUBMIT_GRACE_MS = 15_000;
/**
 * Decides what a pending submit became. The host writes a receipt as soon as
 * it starts a submit, so no receipt once the request has ended and the grace
 * period has passed means the host never started it.
 */
export function pendingSubmitOutcome(
  pending: PendingSubmit,
  facts: {
    recorded: boolean;
    status: string;
    inFlight: boolean;
    now: number;
  },
): "ran" | "notRun" | "wait" {
  if (facts.recorded || facts.status === "done") return "ran";
  if (facts.status === "failed") return "notRun";
  const sentAt = typeof pending.sentAt === "number" ? pending.sentAt : 0;
  if (
    facts.status === "unknown" &&
    !facts.inFlight &&
    facts.now - sentAt >= PENDING_SUBMIT_GRACE_MS
  )
    return "notRun";
  return "wait";
}
export type RemoteView = {
  projectId?: string;
  sessionId?: string;
  panel: "chat" | "files" | "git" | "terminal";
  drafts: Record<string, string>;
  buffers: Record<string, FileBuffer>;
  selectedFile?: string;
  pinned: string[];
  pendingSubmissions: Record<string, PendingSubmit>;
  resolvedQuestions: Record<string, string>;
};
export const emptyView = (): RemoteView => ({
  panel: "chat",
  drafts: {},
  buffers: {},
  pinned: [],
  pendingSubmissions: {},
  resolvedQuestions: {},
});
type StoragePort = Pick<Storage, "getItem" | "setItem">;
const memory = new Map<string, RemoteView>();
const hydrationBuffers = new Map<string, Set<Set<string>>>();
function rememberCurrentView(host: string, view: RemoteView) {
  const previous = memory.get(host);
  if (previous)
    for (const seen of hydrationBuffers.get(host) ?? [])
      for (const id of Object.keys(previous.buffers)) seen.add(id);
  memory.set(host, view);
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const key = (host: string) => `gyro.remote.view.${host}`;
export function readView(
  host: string,
  storage: StoragePort = localStorage,
): RemoteView {
  if (memory.has(host)) return memory.get(host)!;
  try {
    const raw = storage.getItem(key(host));
    if (!raw || raw.length > 5 * 1024 * 1024) return emptyView();
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return emptyView();
    const result = emptyView();
    if (typeof value.projectId === "string") result.projectId = value.projectId;
    if (typeof value.sessionId === "string") result.sessionId = value.sessionId;
    if (typeof value.selectedFile === "string")
      result.selectedFile = value.selectedFile;
    if (
      typeof value.panel === "string" &&
      ["chat", "files", "git", "terminal"].includes(value.panel)
    )
      result.panel = value.panel as RemoteView["panel"];
    if (record(value.drafts))
      result.drafts = Object.fromEntries(
        Object.entries(value.drafts).filter(
          ([, text]) => typeof text === "string",
        ),
      ) as Record<string, string>;
    if (record(value.resolvedQuestions))
      result.resolvedQuestions = Object.fromEntries(
        Object.entries(value.resolvedQuestions).filter(
          ([, id]) => typeof id === "string",
        ),
      ) as Record<string, string>;
    if (Array.isArray(value.pinned))
      result.pinned = value.pinned.filter(
        (id): id is string => typeof id === "string",
      );
    if (record(value.buffers))
      for (const [id, buffer] of Object.entries(value.buffers)) {
        if (
          record(buffer) &&
          typeof buffer.text === "string" &&
          record(buffer.file) &&
          typeof buffer.file.path === "string" &&
          typeof buffer.file.content === "string" &&
          typeof buffer.file.contentHash === "string" &&
          typeof buffer.file.sizeBytes === "number" &&
          typeof buffer.file.truncated === "boolean"
        )
          result.buffers[id] = buffer as FileBuffer;
      }
    if (record(value.pendingSubmissions))
      for (const [id, pending] of Object.entries(value.pendingSubmissions)) {
        if (
          record(pending) &&
          ["requestId", "turnId", "message", "draft"].every(
            (key) => typeof pending[key] === "string",
          )
        )
          result.pendingSubmissions[id] = pending as PendingSubmit;
      }
    return result;
  } catch {
    return emptyView();
  }
}
/** Keep the complete view in memory even when browser storage cannot fit it. */
export function persistView(
  host: string,
  view: RemoteView,
  storage: StoragePort = localStorage,
): boolean {
  rememberCurrentView(host, view);
  return writeSmallView(host, view, storage);
}
function writeSmallView(
  host: string,
  view: RemoteView,
  storage: StoragePort = localStorage,
): boolean {
  try {
    storage.setItem(key(host), JSON.stringify({ ...view, buffers: {} }));
    return true;
  } catch {
    return false;
  }
}

/** Current drafts and completed removals take precedence over recovered rows. */
export function mergeHydratedBuffers(
  stored: RemoteView["buffers"],
  current: RemoteView["buffers"],
  seen: Iterable<string>,
): RemoteView["buffers"] {
  const buffers = { ...stored, ...current };
  // Absence is meaningful for every buffer seen before or during the read.
  // A rename or deletion owns that key; an older disk row must not revive it.
  for (const id of seen)
    if (!(id in current)) delete buffers[id];
  return buffers;
}

export async function hydrateView(host: string): Promise<RemoteView> {
  const initial = readView(host);
  const seen = new Set(Object.keys(initial.buffers));
  const active = hydrationBuffers.get(host) ?? new Set<Set<string>>();
  active.add(seen);
  hydrationBuffers.set(host, active);
  try {
    const stored = await readBuffers(host);
    // Track every buffer seen during I/O, including one opened and then
    // removed before the read finishes. Absence must remain meaningful.
    const view = readView(host);
    const buffers = mergeHydratedBuffers(stored, view.buffers, seen);
    const hydrated = { ...view, buffers };
    rememberCurrentView(host, hydrated);
    return hydrated;
  } finally {
    active.delete(seen);
    if (!active.size && hydrationBuffers.get(host) === active)
      hydrationBuffers.delete(host);
  }
}
export async function persistViewAsync(
  host: string,
  view: RemoteView,
): Promise<boolean> {
  rememberCurrentView(host, view);
  if (!(await writeBuffers(host, view.buffers))) return false;
  // Buffer commits are serialized per host. Persist this exact receipt state,
  // without replacing a newer in-memory draft while its debounce is pending.
  return writeSmallView(host, view);
}
export function rememberView(host: string, view: RemoteView) {
  rememberCurrentView(host, view);
}
