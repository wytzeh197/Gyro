import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppDestination, SettingsSectionId } from "./types";
import {
  TOUR_STEPS,
  TOUR_VERSION,
  logTourEvent,
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
  storage?: TourStorage;
};

export function FirstRunTour({
  destination,
  providerConfigured,
  onNavigate,
  onOpenSettings,
  storage,
}: FirstRunTourProps) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const returnTo = useRef<AppDestination>("workspace");
  const navigated = useRef(false);
  const requested = useRef(false);
  const finished = useRef(false);
  const store = useRef<TourStorage | null>(null);

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

  useEffect(() => {
    const step = steps[index];
    if (!step) return;
    if (step.navigate && destination !== "settings" && !requested.current) {
      requested.current = true;
      returnTo.current = destination;
      navigated.current = true;
      onOpenSettings(step.navigate.section ?? "providers");
    }
    const update = () => {
      const anchor = resolveTourAnchor(step.anchor);
      if (anchor) setRect(anchor.getBoundingClientRect());
    };
    update();
    const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
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
      setRect(null);
      setIndex(next);
    }
  };

  const step = steps[index];
  if (!step) return null;
  const spot = rect
    ? {
        top: rect.top - 8,
        left: rect.left - 8,
        width: rect.width + 16,
        height: rect.height + 16,
      }
    : undefined;

  return createPortal(
    <div className="gyro-tour" data-tour-version={TOUR_VERSION}>
      {spot ? <div className="gyro-tour-spotlight" style={spot} /> : null}
      <section
        aria-labelledby="gyro-tour-title"
        aria-modal="false"
        className="gyro-tour-card"
        role="dialog"
      >
        <div className="gyro-tour-progress">
          <span className="gyro-tour-step-count">
            Step {index + 1} of {steps.length}
          </span>
        </div>
        <h2 className="gyro-tour-title" id="gyro-tour-title">
          {step.title}
        </h2>
        <p className="gyro-tour-body">{step.body({ providerConfigured })}</p>
        <div className="gyro-tour-actions">
          <button
            className="gyro-tour-skip"
            onClick={() => finish("dismissed")}
            type="button"
          >
            Skip tour
          </button>
          <div className="gyro-tour-nav">
            {index > 0 ? (
              <button
                className="gyro-tour-secondary"
                onClick={() => move(index - 1)}
                type="button"
              >
                Back
              </button>
            ) : null}
            <button
              className="gyro-tour-primary"
              onClick={() => move(index + 1)}
              type="button"
            >
              {index + 1 === steps.length ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
