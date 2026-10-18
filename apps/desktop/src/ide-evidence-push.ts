// Coalesces live IDE evidence pushes to the native capability bridge.
//
// The snapshot the shell derives is rebuilt on every keystroke and cursor
// move, and it carries the text of every open buffer, so pushing it verbatim
// meant one full IPC update — plus a redaction and validation pass on the
// native side — per character typed. A scheduler keeps the bridge fresh
// without paying that: the first change goes out immediately, sustained
// editing is throttled to one update per `throttleMs`, and the last change
// lands `idleMs` after editing pauses. A turn that needs the newest evidence
// awaits its own push, so this only governs background refreshes.

type Timer = ReturnType<typeof setTimeout>;

export type IdeEvidenceSchedulerOptions = {
  /** Quiet period after the last change before the trailing push. */
  idleMs?: number;
  /** Minimum gap between two pushes while evidence keeps changing. */
  throttleMs?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
};

export type IdeEvidenceScheduler<T> = {
  schedule: (evidence: T) => void;
  /** Sends the newest pending evidence right away. */
  flush: () => void;
  /** Drops pending evidence, e.g. when the workspace changes. */
  cancel: () => void;
  /** Whether a push is queued. */
  isPending: () => boolean;
};

export function createIdeEvidenceScheduler<T>(
  send: (evidence: T) => void,
  options: IdeEvidenceSchedulerOptions = {},
): IdeEvidenceScheduler<T> {
  const idleMs = options.idleMs ?? 300;
  const throttleMs = options.throttleMs ?? 1000;
  const now = options.now ?? (() => Date.now());
  const startTimer =
    options.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const stopTimer = options.clearTimeout ?? ((timer: Timer) => clearTimeout(timer));

  let trailing: Timer | undefined;
  let pending: T | undefined;
  let hasPending = false;
  // The first push of a burst should happen immediately, so start as if the
  // throttle window already elapsed.
  let lastSentAt = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (trailing !== undefined) {
      stopTimer(trailing);
      trailing = undefined;
    }
    if (!hasPending) return;
    const evidence = pending as T;
    pending = undefined;
    hasPending = false;
    lastSentAt = now();
    send(evidence);
  };

  const schedule = (evidence: T) => {
    pending = evidence;
    hasPending = true;
    if (trailing !== undefined) {
      stopTimer(trailing);
      trailing = undefined;
    }
    if (now() - lastSentAt >= throttleMs) {
      flush();
      return;
    }
    trailing = startTimer(() => {
      trailing = undefined;
      flush();
    }, idleMs);
  };

  const cancel = () => {
    if (trailing !== undefined) {
      stopTimer(trailing);
      trailing = undefined;
    }
    pending = undefined;
    hasPending = false;
  };

  return { schedule, flush, cancel, isPending: () => hasPending };
}
