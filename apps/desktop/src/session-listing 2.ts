import type { Session } from "@gyro-dev/ui";

/*
 * Which sessions the user sees as chats.
 *
 * A session another chat's turn started — a research sub-agent keeps its
 * transcript in a session of its own — belongs to that turn rather than to the
 * chat list: it is opened from the call that ran it, and the chat that started
 * it takes it away again when it is deleted.
 */

/** Trailing slashes never decide whether two paths are the same project. */
export function normalizeProjectPath(path?: string) {
  return path?.trim().replace(/\/+$/, "") ?? "";
}

export function visibleSessionsForProjects(
  sessions: Session[],
  removedProjectPaths: string[],
) {
  const removed = new Set(removedProjectPaths.map(normalizeProjectPath));
  return sessions.filter(
    (session) =>
      !session.parentSessionId &&
      !removed.has(normalizeProjectPath(session.workspacePath)),
  );
}
