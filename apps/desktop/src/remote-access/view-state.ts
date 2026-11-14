import type { FileBuffer } from "./types";
export type PendingSubmit = {
  requestId: string;
  turnId: string;
  message: string;
  draft: string;
};
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
  memory.set(host, view);
  try {
    storage.setItem(key(host), JSON.stringify(view));
    return true;
  } catch {
    return false;
  }
}
