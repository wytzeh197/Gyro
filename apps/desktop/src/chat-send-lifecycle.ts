/** A send owns preparation before any asynchronous work or native run exists. */
export function createChatSendLifecycle() {
  const preparing = new Map<string, ChatSendAttempt>();
  const attempts = new Map<string, Set<ChatSendAttempt>>();
  type ChatSendAttempt = {
    started: boolean;
    cancelled: boolean;
    keys: Set<string>;
    bind: (key: string) => void;
    check: () => void;
    start: () => void;
    release: () => void;
  };
  return {
    reserve(key: string): ChatSendAttempt | undefined {
      if (preparing.has(key)) return;
      const attempt: ChatSendAttempt = {
        started: false,
        cancelled: false,
        keys: new Set(),
        bind(owner) {
          attempt.keys.add(owner);
          const group = attempts.get(owner) ?? new Set();
          group.add(attempt);
          attempts.set(owner, group);
          if (!attempt.started) preparing.set(owner, attempt);
        },
        check() {
          if (attempt.cancelled)
            throw new Error("chat cancelled by user before provider launch");
        },
        start() {
          attempt.check();
          attempt.started = true;
          for (const owner of attempt.keys)
            if (preparing.get(owner) === attempt) preparing.delete(owner);
        },
        release() {
          for (const owner of attempt.keys) {
            if (preparing.get(owner) === attempt) preparing.delete(owner);
            const group = attempts.get(owner);
            group?.delete(attempt);
            if (!group?.size) attempts.delete(owner);
          }
        },
      };
      attempt.bind(key);
      return attempt;
    },
    /** True when Stop has handled a send which has not reached native code. */
    cancel(sessionId: string) {
      const group = attempts.get(sessionId);
      if (!group?.size) return false;
      let nativeStarted = false;
      for (const attempt of group) {
        attempt.cancelled = true;
        nativeStarted ||= attempt.started;
      }
      return !nativeStarted;
    },
  };
}

/** A failed settings write must be retried, not bypassed using stale disk config. */
export async function waitForChatConfigSave(
  pending: Promise<unknown>,
  retry: () => Promise<boolean>,
) {
  try {
    await pending;
  } catch {
    if (!(await retry()))
      throw new Error(
        "Could not save chat settings. Retry sending after fixing the settings save error.",
      );
  }
}
