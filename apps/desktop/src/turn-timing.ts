import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { type ProviderStreamOrderState } from "./provider-stream-events";
import { createProviderStreamDispatcher } from "./provider-stream-dispatcher";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderChatStreamEvent, SessionEvent } from "@gyro-dev/ui";

type Sample = {
  started: number;
  invoked?: number;
  received?: number;
  paint?: number;
  settled?: number;
  scheduled?: boolean;
};
let enabled = false;
const samples = new Map<string, Sample>();
const clock = () => performance.now();

export function useProviderStreamTiming(
  order: MutableRefObject<ProviderStreamOrderState>,
  dispatch: (event: ProviderChatStreamEvent) => void,
) {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const dispatcher = useMemo(
    () =>
      createProviderStreamDispatcher(order.current, (event) => {
        receiveTurnTiming(event);
        dispatchRef.current(event);
      }),
    [order],
  );
  useEffect(() => () => dispatcher.dispose(), [dispatcher]);
  return dispatcher.push;
}

export function useTurnTiming(events: SessionEvent[], isSurfaceVisible = true) {
  const visibleRef = useRef(isSurfaceVisible);
  visibleRef.current = isSurfaceVisible;
  useEffect(() => {
    void initializeTurnTiming();
  }, []);
  useEffect(() => {
    committedTurnTiming(events, () => visibleRef.current);
  }, [events, isSurfaceVisible]);
}

export async function initializeTurnTiming() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  enabled = await invoke<boolean>("timing_diagnostics_enabled").catch(
    () => false,
  );
}
export function beginTurnTiming(turnId: string) {
  if (!enabled) return;
  if (samples.size >= 128) samples.delete(samples.keys().next().value!);
  samples.set(turnId, { started: clock() });
}
export function receiveTurnTiming(event: ProviderChatStreamEvent) {
  const sample = event.turnId ? samples.get(event.turnId) : undefined;
  if (!sample || sample.received !== undefined) return;
  if (
    (event.phase === "delta" && event.textDelta) ||
    (event.phase === "activity" && event.activityLabel)
  ) {
    sample.received = clock();
  }
}

// Called from a React effect after the real event has committed. Two animation
// frames give a paint opportunity between callbacks, not a hardware paint timestamp.
// A hidden document is deliberately unmeasured rather than labelled fast.
export function committedTurnTiming(
  events: SessionEvent[],
  isSurfaceVisible: () => boolean = () => true,
) {
  if (!enabled || !isSurfaceVisible() || document.visibilityState !== "visible")
    return;
  for (const event of events) {
    const turnId = event.turnId;
    const sample = turnId ? samples.get(turnId) : undefined;
    const kind = (event.payload as { kind?: string } | undefined)?.kind;
    if (
      !turnId ||
      !sample ||
      sample.received === undefined ||
      sample.scheduled ||
      (kind !== "provider-activity" && kind !== "provider-stream")
    )
      continue;
    sample.scheduled = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!isSurfaceVisible() || document.visibilityState !== "visible") {
          sample.scheduled = false;
          return;
        }
        sample.paint = clock();
        save(turnId, sample);
      }),
    );
  }
}
function save(turnId: string, sample: Sample) {
  const sinceSend = (value?: number) =>
    value === undefined ? null : Math.max(0, value - sample.started);
  void invoke("record_frontend_timing", {
    value: {
      turnId,
      sendToInvokeMs: sinceSend(sample.invoked),
      sendToReceivedMs: sinceSend(sample.received),
      receivedToPaintMs:
        sample.paint === undefined || sample.received === undefined
          ? null
          : Math.max(0, sample.paint - sample.received),
      sendToSettledMs: sinceSend(sample.settled),
    },
  }).catch(() => {
    console.warn("Gyro timing measurement could not be saved");
  });
}
export async function invokeTimedProviderChat<T>(
  command: string,
  args: { request: { turnId?: string; [key: string]: unknown } },
): Promise<T> {
  const turnId = args.request.turnId;
  const sample = turnId ? samples.get(turnId) : undefined;
  if (sample) sample.invoked = clock();
  try {
    return await invoke<T>(command, args);
  } finally {
    if (sample && turnId) {
      sample.settled = clock();
      save(turnId, sample);
      // Keep a bounded tail for a final event which paints after the RPC settles.
    }
  }
}
