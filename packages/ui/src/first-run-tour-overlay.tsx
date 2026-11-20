import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { popoverViewportRect } from "./composer-popover-bounds";
import { useDialogDismiss } from "./use-dialog-dismiss";
import type { AppDestination } from "./types";
import {
  TOUR_VERSION,
  FIRST_TASK_PROMPT,
  logTourEvent,
  pendingTourSteps,
  placeTourCard,
  readTourRecord,
  resolveTourAnchor,
  writeTourRecord,
  type TourStep,
  type TourStorage,
} from "./first-run-tour";

export type FirstRunTourProps = {
  destination: AppDestination;
  providerConfigured: boolean;
  /**
   * True while the user is busy (typing a draft, a dialog or palette is open).
   * The tour waits for an idle moment instead of opening over their work.
   */
  paused?: boolean;
  onActiveChange?: (active: boolean) => void;
  /** Last-step action when no provider is connected yet. */
  onConnectProvider?: () => void;
  /** Last-step action once a provider is connected. */
  onStartFirstTask?: (prompt: string) => void;
  storage?: TourStorage;
};

/** How long the workspace must sit idle before the tour opens. */
const TOUR_IDLE_DELAY_MS = 1200;

type FinalAction = "first-task" | "connect" | null;

export function FirstRunTour({
  destination,
  providerConfigured,
  paused = false,
  onActiveChange,
  onConnectProvider,
  onStartFirstTask,
  storage,
}: FirstRunTourProps) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const finished = useRef(false);
  const store = useRef<TourStorage | null>(null);

  useLayoutEffect(() => {
    onActiveChange?.(steps.length > 0);
    return () => onActiveChange?.(false);
  }, [onActiveChange, steps.length]);

  useEffect(() => {
    try {
      store.current = storage ?? window.localStorage;
    } catch {
      store.current = null;
    }
    if (steps.length > 0 || finished.current) return;
    if (destination !== "workspace" || paused) return;
    const pending = pendingTourSteps(readTourRecord(store.current));
    if (pending.length === 0) return;
    const timer = window.setTimeout(() => {
      const resolved = pending.filter((step) => {
        if (resolveTourAnchor(step.anchor)) return true;
        logTourEvent("tour.step.skipped.missingAnchor", { step: step.id });
        return false;
      });
      if (resolved.length === 0) {
        logTourEvent("tour.empty");
        return;
      }
      logTourEvent("tour.started", { steps: resolved.map((step) => step.id) });
      setSteps(resolved);
      setIndex(0);
    }, TOUR_IDLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [destination, paused, steps.length, storage]);

  const finish = (
    status: "complete" | "dismissed",
    detail: Record<string, unknown> = {},
  ) => {
    finished.current = true;
    // Every catalog step counts as seen: a skipped tour must not come back
    // next launch with its remaining steps.
    writeTourRecord(store.current, status);
    logTourEvent(`tour.${status}`, { step: steps[index]?.id, ...detail });
    setSteps([]);
  };

  const move = (next: number) => {
    if (next >= steps.length) {
      finish("complete");
      return;
    }
    if (next >= 0) setIndex(next);
  };

  const step = steps[index];
  if (!step) return null;
  const isLast = index + 1 === steps.length;
  // The last step ends in whatever gets this user to a first result. A first
  // task is only offered once it could actually be sent.
  const finalAction: FinalAction = !isLast
    ? null
    : providerConfigured
      ? onStartFirstTask
        ? "first-task"
        : null
      : onConnectProvider
        ? "connect"
        : null;
  return createPortal(
    <TourCoachmark
      destination={destination}
      finalAction={finalAction}
      index={index}
      onAction={() => {
        if (finalAction === "first-task") {
          finish("complete", { action: "first-task" });
          onStartFirstTask?.(FIRST_TASK_PROMPT);
        } else if (finalAction === "connect") {
          finish("complete", { action: "connect" });
          onConnectProvider?.();
        }
      }}
      onDismiss={() => finish("dismissed")}
      // Using the highlighted control is the point of the step. Get out of
      // the way so its own menu or focus is not trapped under the overlay.
      onEngage={() => finish("complete", { action: "engaged" })}
      onMove={move}
      onNotNow={() => finish("complete", { action: "not-now" })}
      providerConfigured={providerConfigured}
      step={step}
      total={steps.length}
    />,
    document.body,
  );
}

function TourCoachmark({
  destination,
  finalAction,
  index,
  onAction,
  onDismiss,
  onEngage,
  onMove,
  onNotNow,
  providerConfigured,
  step,
  total,
}: {
  destination: AppDestination;
  finalAction: FinalAction;
  index: number;
  onAction: () => void;
  onDismiss: () => void;
  onEngage: () => void;
  onMove: (index: number) => void;
  onNotNow: () => void;
  providerConfigured: boolean;
  step: TourStep;
  total: number;
}) {
  const copyContext = {
    providerConfigured,
    offersFirstTask: finalAction === "first-task",
  };
  const layerRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const blockerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const engage = useRef(onEngage);
  engage.current = onEngage;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const anchor = resolveTourAnchor(step.anchor);
      if (anchor && event.target instanceof Node && anchor.contains(event.target))
        engage.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [step.anchor]);
  const { ref: cardRef, dismiss } = useDialogDismiss<HTMLElement>(onDismiss);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const card = cardRef.current;
    const spotlight = spotlightRef.current;
    if (!layer || !card || !spotlight) return;
    let observedAnchor: HTMLElement | null = null;
    const update = () => {
      const anchor = resolveTourAnchor(step.anchor);
      if (anchor !== observedAnchor) {
        if (observedAnchor) observer.unobserve(observedAnchor);
        if (anchor) observer.observe(anchor);
        observedAnchor = anchor;
      }
      // The composer is zoomed to 95%. Older native WebKit returns unzoomed
      // client rectangles; share the same normalization as its popovers.
      const bounds = popoverViewportRect(layer);
      const size = popoverViewportRect(card);
      const rect = anchor ? popoverViewportRect(anchor) : null;
      const padding = 6;
      const spot = rect
        ? {
            left: Math.max(0, rect.left - bounds.left - padding),
            top: Math.max(0, rect.top - bounds.top - padding),
            right: Math.min(bounds.width, rect.right - bounds.left + padding),
            bottom: Math.min(bounds.height, rect.bottom - bounds.top + padding),
          }
        : null;
      // A target can disappear while a settings page is opening. Never leave
      // the previous step's outline behind or show a cut-out off screen.
      const visible = spot && spot.right > spot.left && spot.bottom > spot.top;
      spotlight.hidden = !visible;
      layer.dataset.hasAnchor = String(Boolean(visible));
      if (visible) {
        Object.assign(spotlight.style, {
          left: `${spot.left / bounds.zoom}px`,
          top: `${spot.top / bounds.zoom}px`,
          width: `${(spot.right - spot.left) / bounds.zoom}px`,
          height: `${(spot.bottom - spot.top) / bounds.zoom}px`,
        });
        // Four blockers frame the cut-out, so the rest of the app stays
        // inert while the highlighted control itself can be clicked.
        const z = bounds.zoom;
        const frames = [
          [0, 0, bounds.width, spot.top],
          [0, spot.bottom, bounds.width, bounds.height - spot.bottom],
          [0, spot.top, spot.left, spot.bottom - spot.top],
          [spot.right, spot.top, bounds.width - spot.right, spot.bottom - spot.top],
        ];
        frames.forEach(([left, top, width, height], frame) => {
          const blocker = blockerRefs.current[frame];
          if (!blocker) return;
          Object.assign(blocker.style, {
            left: `${left! / z}px`,
            top: `${top! / z}px`,
            width: `${Math.max(0, width!) / z}px`,
            height: `${Math.max(0, height!) / z}px`,
          });
        });
      }
      const position =
        rect && visible
          ? placeTourCard(
              {
                left: rect.left - bounds.left,
                top: rect.top - bounds.top,
                width: rect.width,
                height: rect.height,
              },
              size,
              step.placement,
              bounds,
            )
          : {
              left: Math.max(12, (bounds.width - size.width) / 2),
              top: Math.max(12, (bounds.height - size.height) / 2),
              placement: "center",
            };
      card.style.left = `${position.left / bounds.zoom}px`;
      card.style.top = `${position.top / bounds.zoom}px`;
      card.dataset.placement = position.placement;
      card.dataset.positioned = "true";
    };
    const observer = new ResizeObserver(update);
    observer.observe(card);
    observer.observe(layer);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // Also follows asynchronous page switches and layout shifts that do not
    // resize the target itself. No React render is needed for geometry updates.
    const timer = window.setInterval(update, 200);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearInterval(timer);
    };
  }, [cardRef, destination, step]);

  const isLast = index + 1 === total;
  const primaryLabel =
    finalAction === "first-task"
      ? "Try a first task"
      : finalAction === "connect"
        ? "Set up a model"
        : isLast
          ? "Finish"
          : "Next";
  return (
    <div className="gyro-tour" data-tour-version={TOUR_VERSION} ref={layerRef}>
      {[0, 1, 2, 3].map((frame) => (
        <div
          aria-hidden="true"
          className="gyro-tour-blocker"
          key={frame}
          ref={(node) => {
            blockerRefs.current[frame] = node;
          }}
        />
      ))}
      <div className="gyro-tour-spotlight" hidden ref={spotlightRef} />
      <section
        aria-describedby="gyro-tour-body"
        aria-labelledby="gyro-tour-title"
        aria-modal="true"
        className="gyro-tour-card"
        ref={cardRef}
        role="dialog"
      >
        <div className="gyro-tour-progress">
          <span className="gyro-tour-step-count">
            Step {index + 1} of {total}
          </span>
          <div aria-hidden="true" className="gyro-tour-dots">
            {Array.from({ length: total }, (_, dot) => (
              <span
                className={
                  dot === index
                    ? "is-active"
                    : dot < index
                      ? "is-done"
                      : undefined
                }
                key={dot}
              />
            ))}
          </div>
        </div>
        <h2 className="gyro-tour-title" id="gyro-tour-title">
          {step.title(copyContext)}
        </h2>
        <p className="gyro-tour-body" id="gyro-tour-body">
          {step.body(copyContext)}
        </p>
        <div className="gyro-tour-actions">
          <button
            className="gyro-tour-skip"
            onClick={finalAction ? onNotNow : dismiss}
            type="button"
          >
            {finalAction ? "Not now" : "Skip tour"}
          </button>
          <div className="gyro-tour-nav">
            {index > 0 ? (
              <button
                className="gyro-tour-secondary"
                onClick={() => onMove(index - 1)}
                type="button"
              >
                Back
              </button>
            ) : null}
            <button
              className="gyro-tour-primary"
              onClick={() => (finalAction ? onAction() : onMove(index + 1))}
              type="button"
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
