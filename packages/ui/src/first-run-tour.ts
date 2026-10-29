import type { AppDestination, SettingsSectionId } from "./types";

/**
 * The first-run tour is a versioned catalog, not a scripted walkthrough.
 *
 * Bump TOUR_VERSION whenever the catalog changes shape. A stored record for an
 * older version no longer suppresses the tour, so a UI change that invalidates
 * the copy re-runs the new tour once instead of leaving a stale one behind.
 */
export const TOUR_VERSION = 1;

/** Versioned so a re-release of the tour can supersede the old record. */
export const TOUR_STORAGE_KEY = "gyro.first-run-tour";

export type TourAnchorId =
  | "composer.project"
  | "composer.input"
  | "settings.providers"
  | "sidebar.ide"
  | "panel.tabs";

export type TourPlacement = "top" | "bottom" | "left" | "right";

export type TourStepId =
  | "project"
  | "composer"
  | "models"
  | "workspace"
  | "panel";

export type TourContext = {
  providerConfigured: boolean;
};

export type TourStep = {
  id: TourStepId;
  anchor: TourAnchorId;
  placement: TourPlacement;
  title: string;
  /** Copy is a function so provider state can change the same step, not add one. */
  body: (context: TourContext) => string;
  /** When set, the tour navigates before it looks for the anchor. */
  navigate?: {
    destination: AppDestination;
    section?: SettingsSectionId;
  };
};

/**
 * Anchors are stable data attributes, never selectors over layout classes.
 * A refactor can move the element; as long as the anchor id survives, the tour
 * follows it.
 */
export const TOUR_ANCHOR_SELECTORS: Record<TourAnchorId, string> = {
  "composer.project": '[data-tour="composer.project"]',
  "composer.input": '[data-tour="composer.input"]',
  "settings.providers": '[data-tour="settings.providers"]',
  "sidebar.ide": '[data-tour="sidebar.ide"]',
  "panel.tabs": '[data-tour="panel.tabs"], [data-tour="panel.launcher"]',
};

/**
 * The five steps, in the order a new user needs the mental model:
 * what the agent can see, how to ask, where models live, where the IDE lives,
 * and where review/panels live.
 */
export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: "project",
    anchor: "composer.project",
    placement: "top",
    title: "This is your real folder",
    body: () =>
      "Gyro works on the folder on your disk — not a sandbox or a copy. This chip names the project the agent can read and change.",
  },
  {
    id: "composer",
    anchor: "composer.input",
    placement: "top",
    title: "Ask in plain language",
    body: () =>
      "Describe the change you want, or point at a file with @. No commands to learn — the composer is the whole interaction.",
  },
  {
    id: "models",
    anchor: "settings.providers",
    placement: "right",
    title: "Models live in Settings",
    body: ({ providerConfigured }) =>
      providerConfigured
        ? "Settings is where you switch the default model, connect another provider, and tune approvals. You're connected — this is the control room."
        : "Start by connecting a provider and picking a model in Settings. It's also where approvals and model defaults live. We'll take you there.",
    navigate: { destination: "settings", section: "providers" },
  },
  {
    id: "workspace",
    anchor: "sidebar.ide",
    placement: "right",
    title: "The workspace IDE is up top",
    body: () =>
      "The top of the sidebar switches between this chat and the full workspace: files, search, source control, and test runs. Same project, same edits.",
  },
  {
    id: "panel",
    anchor: "panel.tabs",
    placement: "bottom",
    title: "Browser, diffs, and the rest",
    body: () =>
      "The right panel holds the browser, review diffs, changes, terminal, canvas, and agents. Edits arrive as diffs — nothing lands until you approve.",
  },
]);

export type TourRecordStatus = "complete" | "dismissed";

export type TourRecord = {
  version: number;
  status: TourRecordStatus;
  recordedAt: string;
};

export type TourStorage = Pick<Storage, "getItem" | "setItem">;

function defaultTourStorage(): TourStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isTourRecord(value: unknown): value is TourRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TourRecord>;
  return (
    typeof candidate.version === "number" &&
    (candidate.status === "complete" || candidate.status === "dismissed") &&
    typeof candidate.recordedAt === "string"
  );
}

/**
 * A corrupt or unreadable record must never crash first-run. Worse case the
 * tour runs once; the next completion writes a clean record.
 */
export function readTourRecord(
  storage: TourStorage | null = defaultTourStorage(),
): TourRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isTourRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTourRecord(
  storage: TourStorage | null,
  status: TourRecordStatus,
): void {
  if (!storage) return;
  const record: TourRecord = {
    version: TOUR_VERSION,
    status,
    recordedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(TOUR_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be denied; the tour still finishes for this session.
  }
}

/**
 * Only a record for the current catalog version suppresses the tour. An old
 * version means the UI changed under the old copy, so the new tour runs once.
 */
export function shouldRunTour(record: TourRecord | null): boolean {
  return record?.version !== TOUR_VERSION;
}

/**
 * Resolves the first visible element carrying the anchor. A closed companion
 * dock still has its tab header in the DOM, so visibility is part of the test,
 * not just presence.
 */
export function resolveTourAnchor(
  anchor: TourAnchorId,
  doc: Document | undefined = typeof document === "undefined"
    ? undefined
    : document,
): HTMLElement | null {
  if (!doc) return null;
  let nodes: NodeListOf<HTMLElement>;
  try {
    nodes = doc.querySelectorAll<HTMLElement>(TOUR_ANCHOR_SELECTORS[anchor]);
  } catch {
    return null;
  }
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = doc.defaultView?.getComputedStyle(node);
    if (!style) continue;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      continue;
    }
    if (node.closest('[aria-hidden="true"]')) continue;
    return node;
  }
  return null;
}

export type TourRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type TourSize = {
  width: number;
  height: number;
};

export type TourViewport = {
  width: number;
  height: number;
};

export type TourCardPosition = {
  left: number;
  top: number;
  placement: TourPlacement;
};

function opposite(placement: TourPlacement): TourPlacement {
  if (placement === "top") return "bottom";
  if (placement === "bottom") return "top";
  if (placement === "left") return "right";
  return "left";
}

/**
 * Places the card beside the anchor, flips when the preferred side lacks room,
 * then clamps into the viewport. Pure so the placement logic is testable
 * without a DOM.
 */
export function placeTourCard(
  anchor: TourRect,
  card: TourSize,
  preferred: TourPlacement,
  viewport: TourViewport,
): TourCardPosition {
  const gap = 14;
  const margin = 12;
  const room: Record<TourPlacement, number> = {
    top: anchor.top - gap - margin,
    bottom: viewport.height - (anchor.top + anchor.height) - gap - margin,
    left: anchor.left - gap - margin,
    right: viewport.width - (anchor.left + anchor.width) - gap - margin,
  };
  const fits = (placement: TourPlacement) =>
    placement === "top" || placement === "bottom"
      ? room[placement] >= card.height
      : room[placement] >= card.width;
  const order: TourPlacement[] = [
    preferred,
    opposite(preferred),
    "bottom",
    "top",
    "right",
    "left",
  ];
  const placement = order.find(fits) ?? preferred;
  const centeredLeft = anchor.left + anchor.width / 2 - card.width / 2;
  const centeredTop = anchor.top + anchor.height / 2 - card.height / 2;
  let left = centeredLeft;
  let top = centeredTop;
  if (placement === "top") top = anchor.top - card.height - gap;
  if (placement === "bottom") top = anchor.top + anchor.height + gap;
  if (placement === "left") left = anchor.left - card.width - gap;
  if (placement === "right") left = anchor.left + anchor.width + gap;
  return {
    left: Math.max(
      margin,
      Math.min(left, viewport.width - card.width - margin),
    ),
    top: Math.max(
      margin,
      Math.min(top, viewport.height - card.height - margin),
    ),
    placement,
  };
}

export type TourEventDetail = Record<string, unknown> & {
  event: string;
  version: number;
};

/**
 * Skips and completions are observable. A missing-anchor skip is the signal
 * that the UI changed and this step's copy is now lying; fix the step instead
 * of learning about it from a user.
 */
export function logTourEvent(
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const payload: TourEventDetail = { event, version: TOUR_VERSION, ...detail };
  try {
    console.info(`[gyro-tour] ${event}`, payload);
  } catch {
    // Console can be unavailable in hardened webviews.
  }
  if (typeof window !== "undefined" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("gyro:tour", { detail: payload }));
  }
}
