/** Completed main-chat use only; picker clicks and old selection counts are not evidence. */
export const MODEL_DEFAULT_SUGGESTION_STORAGE_KEY =
  "gyro.model-default-suggestion.v1";
export const MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS = 500_000;
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_WINDOW = 30 * DAY;
const MODEL_COOLDOWN = 30 * DAY;
const GLOBAL_COOLDOWN = 7 * DAY;
const MAX_USES = 512;
const MAX_DECISIONS = 1_000;

export type CompletedModelUse = {
  providerId: string;
  modelId: string;
  sessionId: string;
  turnId: string;
  completedAt: number;
};

type ModelDecision = {
  cooldownUntil?: number;
  neverSuggestAgain?: true;
};

export type ModelDefaultSuggestionState = {
  version: 1;
  uses: CompletedModelUse[];
  modelDecisions: Record<string, ModelDecision>;
  providerCooldowns: Record<string, number>;
  lastShownAt?: number;
};

export type ModelDefaultSuggestion = {
  providerId: string;
  modelId: string;
  usageCount: number;
  chatCount: number;
  dayCount: number;
};

export function createModelDefaultSuggestionState(): ModelDefaultSuggestionState {
  return { version: 1, uses: [], modelDecisions: {}, providerCooldowns: {} };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value.trim() === value &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function modelDefaultSuggestionKey(providerId: string, modelId: string) {
  return JSON.stringify([providerId, modelId]);
}

function validModelKey(key: string) {
  // All 1,000 permanent choices must fit even with escaped custom model IDs.
  if (JSON.stringify(key).length > 400) return false;
  try {
    const ids: unknown = JSON.parse(key);
    return (
      Array.isArray(ids) &&
      ids.length === 2 &&
      identifier(ids[0]) &&
      identifier(ids[1]) &&
      modelDefaultSuggestionKey(ids[0], ids[1]) === key
    );
  } catch {
    return false;
  }
}

function withinStorageBudget(state: ModelDefaultSuggestionState) {
  // Trim heuristic evidence before user preferences. Valid permanent choices
  // alone fit the budget, so normal writes can never erase them on next load.
  while (
    JSON.stringify(state).length > MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS
  ) {
    if (state.uses.length) {
      state.uses = state.uses.slice(
        Math.max(1, Math.ceil(state.uses.length / 4)),
      );
    } else if (Object.keys(state.providerCooldowns).length) {
      state.providerCooldowns = {};
    } else {
      state.modelDecisions = Object.fromEntries(
        Object.entries(state.modelDecisions).filter(
          ([, decision]) => decision.neverSuggestAgain,
        ),
      );
    }
  }
  return state;
}

function normalizeState(
  value: unknown,
  now: number,
): ModelDefaultSuggestionState {
  const source = record(value);
  if (source?.version !== 1 || !timestamp(now))
    return createModelDefaultSuggestionState();
  const seenTurns = new Set<string>();
  const uses: CompletedModelUse[] = [];
  if (Array.isArray(source.uses)) {
    for (const raw of source.uses.slice(-MAX_USES)) {
      const use = record(raw);
      if (
        !use ||
        !identifier(use.providerId) ||
        !identifier(use.modelId) ||
        !identifier(use.sessionId) ||
        !identifier(use.turnId) ||
        !timestamp(use.completedAt) ||
        use.completedAt > now ||
        use.completedAt < now - HISTORY_WINDOW ||
        seenTurns.has(use.turnId)
      )
        continue;
      seenTurns.add(use.turnId);
      uses.push({
        providerId: use.providerId,
        modelId: use.modelId,
        sessionId: use.sessionId,
        turnId: use.turnId,
        completedAt: use.completedAt,
      });
    }
  }
  const modelDecisions = Object.fromEntries(
    Object.entries(record(source.modelDecisions) ?? {})
      .slice(0, MAX_DECISIONS)
      .flatMap<[string, ModelDecision]>(([key, raw]) => {
        const decision = record(raw);
        if (!validModelKey(key) || !decision) return [];
        if (decision.neverSuggestAgain === true)
          return [[key, { neverSuggestAgain: true as const }]];
        return timestamp(decision.cooldownUntil) && decision.cooldownUntil > now
          ? [
              [
                key,
                {
                  cooldownUntil: Math.min(
                    decision.cooldownUntil,
                    now + MODEL_COOLDOWN,
                  ),
                },
              ],
            ]
          : [];
      }),
  );
  const providerCooldowns = Object.fromEntries(
    Object.entries(record(source.providerCooldowns) ?? {})
      .slice(0, MAX_DECISIONS)
      .filter(
        ([key, until]) => identifier(key) && timestamp(until) && until > now,
      )
      .map(([key, until]) => [
        key,
        Math.min(until as number, now + MODEL_COOLDOWN),
      ]),
  );
  return withinStorageBudget({
    version: 1,
    uses,
    modelDecisions,
    providerCooldowns,
    ...(timestamp(source.lastShownAt)
      ? { lastShownAt: Math.min(source.lastShownAt, now) }
      : {}),
  });
}

/** Deliberately does not migrate the old picker-click storage format. */
export function parseModelDefaultSuggestionState(
  raw: string | null | undefined,
  now: number,
): ModelDefaultSuggestionState {
  if (!raw || raw.length > MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS)
    return createModelDefaultSuggestionState();
  try {
    return normalizeState(JSON.parse(raw), now);
  } catch {
    return createModelDefaultSuggestionState();
  }
}

/** A resolved send can also be queued, cancelled, or preview-only; use the native response. */
export function isSuccessfulModelUseResponse(response: unknown): boolean {
  const result = record(response);
  const assistant = record(result?.assistantEvent);
  const status = record(record(result?.statusEvent)?.payload);
  return status?.status === "done" && assistant?.kind === "assistant-message";
}

export function recordCompletedModelUse(
  state: ModelDefaultSuggestionState,
  use: CompletedModelUse,
  now: number,
): ModelDefaultSuggestionState {
  // Existing evidence wins if a retry or a repeated completion replays its turn.
  const current = normalizeState(state, now);
  if (current.uses.some((item) => item.turnId === use.turnId)) return current;
  return normalizeState({ ...current, uses: [...current.uses, use] }, now);
}

export function modelDefaultSuggestionFor(
  state: ModelDefaultSuggestionState,
  options: {
    providerId: string;
    modelId: string;
    defaultModelId?: string;
    available: boolean;
    shownThisLaunch: boolean;
    now: number;
  },
): ModelDefaultSuggestion | undefined {
  const {
    providerId,
    modelId,
    defaultModelId,
    available,
    shownThisLaunch,
    now,
  } = options;
  if (
    !available ||
    shownThisLaunch ||
    !identifier(providerId) ||
    !identifier(modelId) ||
    modelId === defaultModelId ||
    !timestamp(now)
  )
    return;
  const current = normalizeState(state, now);
  const decision =
    current.modelDecisions[modelDefaultSuggestionKey(providerId, modelId)];
  if (
    decision?.neverSuggestAgain ||
    (decision?.cooldownUntil ?? 0) > now ||
    (current.providerCooldowns[providerId] ?? 0) > now ||
    (current.lastShownAt !== undefined &&
      now - current.lastShownAt < GLOBAL_COOLDOWN)
  )
    return;
  const uses = current.uses.filter(
    (use) => use.providerId === providerId && use.modelId === modelId,
  );
  const chatCount = new Set(uses.map((use) => use.sessionId)).size;
  // UTC calendar days keep the evidence stable across timezone changes.
  const dayCount = new Set(
    uses.map((use) => new Date(use.completedAt).toISOString().slice(0, 10)),
  ).size;
  if (uses.length < 5 || chatCount < 3 || dayCount < 2) return;
  return { providerId, modelId, usageCount: uses.length, chatCount, dayCount };
}

/** Call only when the suggestion is actually shown, not when it becomes eligible. */
export function markModelDefaultSuggestionShown(
  state: ModelDefaultSuggestionState,
  now: number,
): ModelDefaultSuggestionState {
  return normalizeState({ ...state, lastShownAt: now }, now);
}

export function dismissModelDefaultSuggestion(
  state: ModelDefaultSuggestionState,
  options: { providerId: string; modelId: string; neverSuggestAgain?: boolean },
  now: number,
): ModelDefaultSuggestionState {
  const current = normalizeState(state, now);
  if (!identifier(options.providerId) || !identifier(options.modelId))
    return current;
  const key = modelDefaultSuggestionKey(options.providerId, options.modelId);
  const permanent =
    options.neverSuggestAgain || current.modelDecisions[key]?.neverSuggestAgain;
  return normalizeState(
    {
      ...current,
      modelDecisions: {
        ...current.modelDecisions,
        [key]: permanent
          ? { neverSuggestAgain: true }
          : { cooldownUntil: now + MODEL_COOLDOWN },
      },
    },
    now,
  );
}

/** An explicit Settings choice takes priority over behavioral suggestions. */
export function snoozeProviderDefaultSuggestions(
  state: ModelDefaultSuggestionState,
  providerId: string,
  now: number,
): ModelDefaultSuggestionState {
  const current = normalizeState(state, now);
  if (!identifier(providerId)) return current;
  return normalizeState(
    {
      ...current,
      providerCooldowns: {
        ...current.providerCooldowns,
        [providerId]: now + MODEL_COOLDOWN,
      },
    },
    now,
  );
}
