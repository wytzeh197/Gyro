import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { popoverViewportRect } from "./composer-popover-bounds";
import { useDialogDismiss } from "./use-dialog-dismiss";
import type { AppDestination, SettingsSectionId } from "./types";
import {
  TOUR_STEPS,
  TOUR_VERSION,
  logTourEvent,
  placeTourCard,
  readTourRecord,
  resolveTourAnchor,
  shouldRunTour,
  writeTourRecord,
  type TourStep,
  type TourStorage,
} from "./first-run-tour";

export type FirstRunTourProps = {
  destination: AppDestination;
  providerConfigured: boolean;
  onNavigate: (destination: AppDestination) => void;
  onOpenSettings: (section: SettingsSectionId) => void;
  onActiveChange?: (active: boolean) => void;
  storage?: TourStorage;
};

export function FirstRunTour({
  destination,
  providerConfigured,
  onNavigate,
  onOpenSettings,
  onActiveChange,
  storage,
}: FirstRunTourProps) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const returnTo = useRef<AppDestination>("workspace");
  const navigated = useRef(false);
  const requested = useRef(false);
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
    if (destination !== "workspace") return;
    if (!shouldRunTour(readTourRecord(store.current))) return;
    const timer = window.setTimeout(() => {
      const resolved = TOUR_STEPS.filter((step) => {
        if (step.navigate || resolveTourAnchor(step.anchor)) return true;
        logTourEvent("tour.step.skipped.missingAnchor", { step: step.id });
        return false;
      });
      if (resolved.length === 0) {
        logTourEvent("tour.empty");
        return;
      }
      setSteps(resolved);
      setIndex(0);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [destination, steps.length, storage]);

  useLayoutEffect(() => {
    const step = steps[index];
    if (!step) return;
    if (step.navigate && !requested.current) {
      requested.current = true;
      if (destination !== step.navigate.destination) {
        returnTo.current = destination;
        navigated.current = true;
      }
      onOpenSettings(step.navigate.section ?? "providers");
    }
  }, [destination, index, onOpenSettings, steps]);

  const finish = (status: "complete" | "dismissed") => {
    finished.current = true;
    writeTourRecord(store.current, status);
    logTourEvent(`tour.${status}`);
    if (navigated.current) {
      navigated.current = false;
      onNavigate(returnTo.current);
    }
    setSteps([]);
  };

  const move = (next: number) => {
    if (navigated.current && steps[index]?.navigate) {
      navigated.current = false;
      onNavigate(returnTo.current);
    }
    requested.current = false;
    if (next >= steps.length) {
      finish("complete");
      return;
    }
    if (next >= 0) {
      setIndex(next);
    }
  };

  const step = steps[index];
  if (!step) return null;
  return createPortal(
    <TourCoachmark
      destination={destination}
      index={index}
      onDismiss={() => finish("dismissed")}
      onMove={move}
      providerConfigured={providerConfigured}
      step={step}
      total={steps.length}
    />,
    document.body,
  );
}

function TourCoachmark({
  destination,
  index,
  onDismiss,
  onMove,
  providerConfigured,
  step,
  total,
}: {
  destination: AppDestination;
  index: number;
  onDismiss: () => void;
  onMove: (index: number) => void;
  providerConfigured: boolean;
  step: TourStep;
  total: number;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="gyro-tour" data-tour-version={TOUR_VERSION} ref={layerRef}>
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
          {step.title}
        </h2>
        <p className="gyro-tour-body" id="gyro-tour-body">
          {step.body({ providerConfigured })}
        </p>
        <div className="gyro-tour-actions">
          <button className="gyro-tour-skip" onClick={dismiss} type="button">
            Skip tour
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
              onClick={() => onMove(index + 1)}
              type="button"
            >
              {index + 1 === total ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
