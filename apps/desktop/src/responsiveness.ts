import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SessionEvent } from "@gyro-dev/ui";

/** True when a fresh transcript read matches what is already rendered, so the
 * state update can keep the old array and skip a full chat re-render. */
export function sameSessionEvents(
  current: SessionEvent[],
  next: SessionEvent[],
) {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const a = current[index]!;
    const b = next[index]!;
    if (a !== b && (a.id !== b.id || JSON.stringify(a) !== JSON.stringify(b))) {
      return false;
    }
  }
  return true;
}

/** Values that change on every keystroke are written once typing pauses, and
 * before the window goes away so nothing is lost. */
export function useDebouncedPersist<T>(
  value: T,
  persist: (value: T) => void,
  delayMs = 400,
) {
  const pendingRef = useRef<{ value: T } | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    persistRef.current(pending.value);
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  useEffect(() => {
    pendingRef.current = { value };
    const timer = window.setTimeout(flush, delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, flush]);
}

/** Keep one RPC per key in flight. Immediate duplicate requests share it;
 * later refreshes queue one trailing read to observe changes made during IO. */
export function createCoalescedReader(
  read: (key: string) => Promise<void>,
  windowMs = 50,
  now = () => performance.now(),
) {
  type TrailingRead = {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const inFlight = new Map<
    string,
    {
      promise: Promise<void>;
      startedAt: number;
      trailing?: TrailingRead;
    }
  >();
  const launch = (key: string): Promise<void> => {
    const entry: {
      promise: Promise<void>;
      startedAt: number;
      trailing?: TrailingRead;
    } = {
      promise: Promise.resolve(),
      startedAt: now(),
    };
    entry.promise = Promise.resolve()
      .then(() => {
        entry.startedAt = now();
        return read(key);
      })
      .finally(() => {
        if (inFlight.get(key) !== entry) return;
        inFlight.delete(key);
        if (entry.trailing) {
          launch(key).then(entry.trailing.resolve, entry.trailing.reject);
        }
      });
    inFlight.set(key, entry);
    return entry.promise;
  };
  return (key: string): Promise<void> => {
    const active = inFlight.get(key);
    if (!active) return launch(key);
    if (now() - active.startedAt < windowMs) return active.promise;
    if (!active.trailing) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      active.trailing = { promise, resolve, reject };
    }
    // Each caller waits for its read, not for the polling stream to go quiet.
    // Continuous refreshes can queue further work without starving earlier
    // callers or keeping a completed provider turn's finally block waiting.
    return active.trailing.promise;
  };
}

export function useCoalescedByKey(
  read: (key: string) => Promise<void>,
  windowMs = 50,
) {
  const readRef = useRef(read);
  readRef.current = read;
  return useMemo(
    () => createCoalescedReader((key) => readRef.current(key), windowMs),
    [windowMs],
  );
}
