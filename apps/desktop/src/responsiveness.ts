import { useCallback, useEffect, useRef } from "react";
import type { SessionEvent } from "@gyro-dev/ui";

/** True when a fresh transcript read matches what is already rendered, so the
 * state update can keep the old array and skip a full chat re-render. */
export function sameSessionEvents(current: SessionEvent[], next: SessionEvent[]) {
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

/** Calls for the same key that land within `windowMs` share one in-flight read
 * instead of crossing IPC twice (e.g. selecting a session changes both the
 * active id and the pane layout, and each effect asks for the transcript). */
export function useCoalescedByKey(
  read: (key: string) => Promise<void>,
  windowMs = 50,
) {
  const inFlightRef = useRef(
    new Map<string, { promise: Promise<void>; startedAt: number }>(),
  );
  return useCallback(
    (key: string): Promise<void> => {
      const inFlight = inFlightRef.current.get(key);
      if (inFlight && performance.now() - inFlight.startedAt < windowMs) {
        return inFlight.promise;
      }
      const promise = read(key).finally(() => {
        if (inFlightRef.current.get(key)?.promise === promise) {
          inFlightRef.current.delete(key);
        }
      });
      inFlightRef.current.set(key, { promise, startedAt: performance.now() });
      return promise;
    },
    [read, windowMs],
  );
}
