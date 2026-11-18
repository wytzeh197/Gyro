import { popoverViewportRect } from "./composer-popover-bounds";

/**
 * The first-run tour is a short, versioned catalog that ends in an action.
 *
 * Each step carries its own revision. Change a step's copy or target in a way
 * that existing users should see, and bump that step's revision: only steps
 * whose revision is newer than the stored one run again, never the whole tour.
 * TOUR_VERSION is the record schema version, not a replay switch.
 */
export const TOUR_VERSION = 2;

/** Editable first task; choosing it never submits a prompt or approves an edit. */
export const FIRST_TASK_PROMPT =
  "Help me make one small, useful change in this project. First inspect the project instructions and existing tests, then propose a specific change and how to verify it. Wait for my approval before editing. After the approved change, run the relevant checks, show the diff, and report any failed or unrun checks.";

export const TOUR_STORAGE_KEY = "gyro.first-run-tour";

export type TourAnchorId = "composer.project" | "composer.input" | "composer.model";

export type TourPlacement = "top" | "bottom" | "left" | "right";

export type TourStepId = "project" | "composer" | "model";

export type TourContext = {
  providerConfigured: boolean;
  /** The step's primary button starts the first task. */
  offersFirstTask: boolean;
};

export type TourStep = {
  id: TourStepId;
  /** Bump to show this one step again to people who already saw it. */
  revision: number;
  anchor: TourAnchorId;
  placement: TourPlacement;
  title: (context: TourContext) => string;
  /** Copy is a function so provider state can change the same step, not add one. */
  body: (context: TourContext) => string;
};

/**
 * Anchors are stable data attributes, never selectors over layout classes.
 * A refactor can move the element; as long as the anchor id survives, the tour
 * follows it.
 */
export const TOUR_ANCHOR_SELECTORS: Record<TourAnchorId, string> = {
  "composer.project": '[data-tour="composer.project"]',
  "composer.input": '[data-tour="composer.input"]',
  "composer.model": '[data-tour="composer.model"]',
};

/**
 * Three steps, all on the composer a new user is looking at: what Gyro can
 * see, how to ask, and which model answers. The model step comes last because
 * it ends in the action that gets a user to a first result: connect an
 * account, or prepare a first task once one is connected. Code view, panels
 * and Review are taught where they become relevant, not before a first message.
 */
export const TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: "project",
    revision: 1,
    anchor: "composer.project",
    placement: "top",
    title: () => "Your project folder",
    body: () =>
      "Gyro reads and edits files in this folder. Click it to switch to another project.",
  },
  {
    id: "composer",
    revision: 1,
    anchor: "composer.input",
    placement: "top",
    title: () => "Describe a task",
    body: () =>
      "Say what you want changed. Type @ to include files, or attach images. Gyro asks before it edits files or runs commands.",
  },
  {
    id: "model",
    revision: 1,
    anchor: "composer.model",
    placement: "top",
    title: ({ providerConfigured }) =>
      providerConfigured ? "Choose a model" : "Connect an AI account",
    body: ({ providerConfigured, offersFirstTask }) =>
      providerConfigured
        ? offersFirstTask
          ? "Pick the model for this chat here. Ready to try it? A first task prepares a prompt you can edit before sending."
          : "Pick the model for this chat here. You can change it at any time."
        : "Gyro needs an AI account before it can work. Connect one, then pick a model here.",
  },
]);

export type TourRecordStatus = "complete" | "dismissed";

/** Step id to the revision last shown (or skipped past). */
export type TourSeenSteps = Partial<Record<TourStepId, number>>;

export type TourRecord = {
  version: number;
  status: TourRecordStatus;
  recordedAt: string;
  seen: TourSeenSteps;
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

function allStepsSeen(): TourSeenSteps {
  return Object.fromEntries(TOUR_STEPS.map((step) => [step.id, step.revision]));
}

/**
 * Accepts the current record and the version 1 record (no per-step map). A
 * version 1 user already saw the project, composer and model guidance, so the
 * migration counts every current step as seen instead of replaying the tour.
 */
function toTourRecord(value: unknown): TourRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TourRecord>;
  if (
    typeof candidate.version !== "number" ||
    (candidate.status !== "complete" && candidate.status !== "dismissed") ||
    typeof candidate.recordedAt !== "string"
  )
    return null;
  if (candidate.version < 2) {
    return {
      version: TOUR_VERSION,
      status: candidate.status,
      recordedAt: candidate.recordedAt,
      seen: allStepsSeen(),
    };
  }
  const seen: TourSeenSteps = {};
  if (candidate.seen && typeof candidate.seen === "object") {
    for (const [id, revision] of Object.entries(candidate.seen)) {
      if (typeof revision === "number") seen[id as TourStepId] = revision;
    }
  }
  return { ...(candidate as TourRecord), seen };
}

/**
 * A corrupt or unreadable record must never crash first-run. Worst case the
 * tour runs once; the next completion writes a clean record.
 */
export function readTourRecord(
  storage: TourStorage | null = defaultTourStorage(),
): TourRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return null;
    return toTourRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Records the given steps as seen, merged into whatever was seen before.
 * Without a list, every current step counts as seen (skip, dismiss, or a
 * capture fixture that wants the tour out of the way).
 */
export function writeTourRecord(
  storage: TourStorage | null,
  status: TourRecordStatus,
  steps: readonly Pick<TourStep, "id" | "revision">[] = TOUR_STEPS,
): void {
  if (!storage) return;
  const previous = readTourRecord(storage);
  const seen: TourSeenSteps = { ...previous?.seen };
  for (const step of steps) seen[step.id] = step.revision;
  const record: TourRecord = {
    version: TOUR_VERSION,
    status,
    recordedAt: new Date().toISOString(),
    seen,
  };
  try {
    storage.setItem(TOUR_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be denied; the tour still finishes for this session.
  }
}

/** Steps that are new, or revised since this person last saw them. */
export function pendingTourSteps(record: TourRecord | null): TourStep[] {
  return TOUR_STEPS.filter(
    (step) => (record?.seen[step.id] ?? 0) < step.revision,
  );
}

export function shouldRunTour(record: TourRecord | null): boolean {
  return pendingTourSteps(record).length > 0;
}

/**
 * Resolves the first visible element carrying the anchor, preferring the
 * focused split chat. Hidden copies stay in the DOM, so visibility is part of
 * the test, not just presence.
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
  const focusedPane =
    doc.querySelector(
      ".gyro-chat-grid-slot.is-occupied.is-pane-maximized:not(.is-hidden-by-maximize)",
    ) ?? doc.querySelector(".gyro-chat-grid-slot.is-current-pane");
  for (const node of Array.from(nodes)) {
    if (!node.isConnected) continue;
    const pane = node.closest(".gyro-chat-grid-slot");
    if (focusedPane && pane && pane !== focusedPane) continue;
    const rect = popoverViewportRect(node);
    if (rect.width < 2 || rect.height < 2) continue;
    const view = doc.defaultView;
    if (
      view &&
      (rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left >= view.innerWidth ||
        rect.top >= view.innerHeight)
    )
      continue;
    const style = doc.defaultView?.getComputedStyle(node);
    if (!style) continue;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      continue;
    }
    if (node.closest('[aria-hidden="true"], [inert], [hidden]')) continue;
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
