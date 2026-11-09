import type { BrowserViewportState } from "@gyro-dev/ui";

export type SessionBrowserSnapshot = {
  sessionId: string;
  resourceId: string;
  url: string;
  title: string;
  loading: boolean;
  navigationId: number;
  navigationError?: { kind: string; message: string; code: number } | null;
  viewport: BrowserViewportState;
};
type NativeCommand = <T>(
  command: string,
  args: Record<string, unknown>,
) => Promise<T>;

/** Order creation/closure and reject results from a superseded browser lifetime. */
export function createSessionBrowserQueue(invoke: NativeCommand) {
  const lifecycle = new Map<string, Promise<unknown>>();
  const work = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();
  const observations = new Map<string, object>();
  const generation = (sessionId: string) => generations.get(sessionId) ?? 0;
  const invalidate = (sessionId: string) => {
    const next = generation(sessionId) + 1;
    generations.set(sessionId, next);
    // A hung read/history request must not hold Close or the next browser up.
    work.delete(sessionId);
    return next;
  };
  const enqueue = <T>(
    pending: Map<string, Promise<unknown>>,
    sessionId: string,
    operation: () => Promise<T>,
  ) => {
    const result = (pending.get(sessionId) ?? Promise.resolve()).then(
      operation,
    );
    // One failed native request must not poison later commands for this chat.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(sessionId, settled);
    void settled.then(() => {
      if (pending.get(sessionId) === settled) pending.delete(sessionId);
    });
    return result;
  };
  const run = <T>(
    sessionId: string,
    operation: () => Promise<T>,
    success: (value: T) => void,
    failure: (error: unknown) => void,
    replace = false,
  ): Promise<boolean> => {
    const owner = replace ? invalidate(sessionId) : generation(sessionId);
    const creation = replace ? undefined : lifecycle.get(sessionId);
    return enqueue(replace ? lifecycle : work, sessionId, async () => {
      await creation;
      if (generation(sessionId) !== owner) return false;
      try {
        const value = await operation();
        if (generation(sessionId) !== owner) return false;
        success(value);
        return true;
      } catch (error) {
        if (generation(sessionId) === owner) failure(error);
        return false;
      }
    });
  };
  return {
    run,
    replace<T>(
      sessionId: string,
      operation: () => Promise<T>,
      success: (value: T) => void,
      failure: (error: unknown) => void,
    ) {
      return run(sessionId, operation, success, failure, true);
    },
    close(sessionId: string, failure: (error: unknown) => void) {
      const owner = invalidate(sessionId);
      // A later reopen must wait for this close even if the UI has moved on.
      return enqueue(lifecycle, sessionId, async () => {
        try {
          await invoke("session_browser_close", { sessionId });
          return true;
        } catch (error) {
          if (generation(sessionId) === owner) failure(error);
          return false;
        }
      });
    },
    observe(
      sessionId: string,
      resourceId: string | undefined,
      kind: string,
      success: (snapshot: SessionBrowserSnapshot) => void,
    ) {
      // Untagged events cannot prove which browser produced their data.
      if (!resourceId) return Promise.resolve(false);
      const key = JSON.stringify([sessionId, kind]);
      const latest = {};
      observations.set(key, latest);
      const owner = generation(sessionId);
      const creation = lifecycle.get(sessionId);
      return enqueue(work, sessionId, async () => {
        const current = () =>
          generation(sessionId) === owner && observations.get(key) === latest;
        try {
          await creation;
          if (!current()) return false;
          let snapshot: SessionBrowserSnapshot | null;
          try {
            snapshot = await invoke<SessionBrowserSnapshot | null>(
              "session_browser_snapshot",
              { sessionId },
            );
          } catch {
            // Load/title events are best effort; commands report their own errors.
            return false;
          }
          if (
            !current() ||
            snapshot?.sessionId !== sessionId ||
            snapshot.resourceId !== resourceId
          )
            return false;
          success(snapshot);
          return true;
        } finally {
          if (observations.get(key) === latest) observations.delete(key);
        }
      });
    },
  };
}
