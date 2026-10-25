import { createContext } from "react";
import type { FileLifecycle } from "./chat-run";

/**
 * The journal entry Cmd+Z would reverse right now.
 *
 * `path` is absolute. Chat cards carry a workspace-relative path, and
 * `fileMatchesPathUndo` joins them through the open roots.
 */
export type WorkspacePathUndoOffer = {
  action: "created" | "moved" | "trashed";
  path: string;
  label: string;
};

export type WorkspacePathUndoValue = {
  offer: WorkspacePathUndoOffer | null;
  roots: readonly string[];
  undo: () => void;
};

const EMPTY_PATH_UNDO: WorkspacePathUndoValue = {
  offer: null,
  roots: [],
  undo: () => {},
};

export const WorkspacePathUndoContext =
  createContext<WorkspacePathUndoValue>(EMPTY_PATH_UNDO);

function normalizePath(path: string) {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
}

/**
 * True when this card is the path change the journal would undo.
 *
 * A root-level `notes.md` must not match `docs/notes.md`. The relative path is
 * stripped from the absolute one, and the leftover prefix has to be an open
 * workspace root (or a canonical form of that root).
 */
export function fileMatchesPathUndo(
  file: { path: string; lifecycle?: FileLifecycle },
  offer: WorkspacePathUndoOffer | null,
  roots: readonly string[],
): boolean {
  if (!offer || !file.lifecycle || roots.length === 0) return false;
  const actionMatches =
    ((file.lifecycle === "create" || file.lifecycle === "duplicate") &&
      offer.action === "created") ||
    (file.lifecycle === "trash" && offer.action === "trashed") ||
    ((file.lifecycle === "rename" || file.lifecycle === "move") &&
      offer.action === "moved");
  if (!actionMatches) return false;
  const absolute = normalizePath(offer.path);
  const relative = normalizePath(file.path).replace(/^\//, "");
  if (!relative || relative === "/") return false;
  if (absolute === relative || absolute === `/${relative}`) return true;
  const suffix = `/${relative}`;
  if (!absolute.endsWith(suffix)) return false;
  const prefix = absolute.slice(0, -suffix.length) || "/";
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return (
      prefix === normalizedRoot ||
      normalizedRoot.endsWith(prefix) ||
      prefix.endsWith(normalizedRoot)
    );
  });
}
