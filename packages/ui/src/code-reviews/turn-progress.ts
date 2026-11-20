import { useEffect, useMemo, useState } from "react";
import type { SessionEvent } from "../types";
import {
  reviewIsActive,
  type CodeReviewRuntime,
  type CodeReviewStatus,
} from "./types";

export type TurnReviewProgress = {
  turnId: string;
  reviewId: string;
  providerId: string;
  modelId: string;
  status: CodeReviewStatus;
  started: boolean;
  fileCount: number;
};

export type TurnReview = Partial<TurnReviewProgress> & { notice?: string };

type Readings = {
  runtime: CodeReviewRuntime;
  key: string;
  rows: Map<string, TurnReviewProgress>;
  failed: boolean;
};

export function turnReviewPayload(event: SessionEvent) {
  if (
    event.kind !== "system-event" ||
    !event.turnId ||
    !event.payload ||
    typeof event.payload !== "object"
  )
    return;
  const payload = event.payload as Record<string, unknown>;
  return payload.kind === "turn-review-selection" ||
    payload.kind === "turn-second-opinion"
    ? payload
    : undefined;
}

export function useTurnReviews(
  events: SessionEvent[],
  runtime?: CodeReviewRuntime,
) {
  const references = useMemo(() => {
    const byTurn = new Map<
      string,
      { event: SessionEvent; payload: Record<string, unknown> }
    >();
    for (const event of events) {
      const payload = turnReviewPayload(event);
      if (!payload || !event.turnId) continue;
      const kind = payload.kind;
      if (
        kind === "turn-second-opinion" ||
        (kind === "turn-review-selection" && !byTurn.has(event.turnId))
      ) {
        byTurn.set(event.turnId, { event, payload });
      }
    }
    return byTurn;
  }, [events]);
  // Streaming tokens change the event array. Only a new selection or receipt changes this subscription.
  const key = JSON.stringify(
    Array.from(references, ([turn, { event }]) => [turn, event.id]),
  );
  const [readings, setReadings] = useState<Readings>();

  useEffect(() => {
    if (!runtime || key === "[]") return;
    const turnIds = (JSON.parse(key) as [string, string][]).map(
      ([turn]) => turn,
    );
    let disposed = false;
    let busy = false;
    let dirty = false;
    let timer: number | undefined;
    async function refresh() {
      if (disposed || !runtime) return;
      if (busy) {
        dirty = true;
        return;
      }
      window.clearTimeout(timer);
      busy = true;
      try {
        const rows = new Map<string, TurnReviewProgress>();
        for (let i = 0; i < turnIds.length; i += 500) {
          const batch = await runtime.request<TurnReviewProgress[]>(
            "turn-progress",
            { turnIds: turnIds.slice(i, i + 500) },
          );
          if (disposed) return;
          for (const row of batch) rows.set(row.turnId, row);
        }
        if (!dirty) {
          setReadings({ runtime, key, rows, failed: false });
          if (
            Array.from(rows.values()).some((row) => reviewIsActive(row.status))
          ) {
            timer = window.setTimeout(refresh, 3000);
          }
        }
      } catch {
        if (!disposed) {
          setReadings((previous) => ({
            runtime,
            key,
            failed: true,
            rows: new Map(
              previous?.runtime === runtime
                ? Array.from(previous.rows).filter(
                    ([, row]) => !reviewIsActive(row.status),
                  )
                : [],
            ),
          }));
          timer = window.setTimeout(refresh, 3000);
        }
      } finally {
        busy = false;
        if (dirty && !disposed) {
          dirty = false;
          void refresh();
        }
      }
    }
    const unsubscribe = runtime.subscribe(refresh);
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [key, runtime]);

  return useMemo(() => {
    const byTurn = new Map<string, TurnReview>();
    const sameSource = readings?.runtime === runtime && readings;
    for (const [turn, { event, payload }] of references) {
      const row = sameSource && sameSource.rows.get(turn);
      if (row) {
        byTurn.set(turn, row);
        continue;
      }
      if (payload.kind !== "turn-second-opinion") continue;
      const { reviewId, providerId, modelId } = payload;
      const receipt = typeof reviewId === "string" ? reviewId : undefined;
      const loaded = sameSource && sameSource.key === key;
      byTurn.set(turn, {
        reviewId: receipt,
        providerId: typeof providerId === "string" ? providerId : undefined,
        modelId: typeof modelId === "string" ? modelId : undefined,
        notice: !receipt
          ? event.message
          : !runtime
            ? "Open this chat on the desktop to view the second opinion."
            : loaded && sameSource.failed
              ? "Couldn’t load the second opinion. Retrying…"
              : loaded
                ? "This second opinion is no longer available."
                : undefined,
      });
    }
    return byTurn;
  }, [key, readings, references, runtime]);
}
