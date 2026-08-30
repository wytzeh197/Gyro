import type {
  BudgetState,
  ProviderId,
  ProviderLedgerSummary,
  ProviderUsageWindow,
  SessionUsageTotals,
  UsageOriginTotals,
  UsageSafetySnapshot,
} from "./types";

/** The session cost line, as the chat surface renders it. */
export type SessionCostSummary = {
  /** `1.2M tokens across 14 calls`. */
  label: string;
  /** `4 council seats · 1 synthesis`, or undefined when there is nothing to split. */
  breakdown?: string;
  /**
   * `1.1M re-read`, or undefined when cached context is not most of the total.
   *
   * A tool-using turn bills the whole conversation once per call, so the raw
   * total reads far larger than the work the turn actually did. This names the
   * re-read share rather than quietly removing it.
   */
  cachedNote?: string;
  /** Set when any part of the total was estimated rather than reported. */
  estimateNote?: string;
  /** Full sentence for the tooltip, including the estimate caveat. */
  title: string;
  /** Whether the surface should render anything at all. */
  isEmpty: boolean;
};

function trimTrailingZeros(value: string) {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/**
 * Compact token counts, matching the composer context meter's unit choice so
 * the two never disagree about what "1.2M" means.
 */
export function formatTokenCount(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 999_500) {
    const millions = (tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 2);
    return `${trimTrailingZeros(millions)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = (tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1);
    return `${trimTrailingZeros(thousands)}K`;
  }
  return String(Math.round(tokens));
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The breakdown, biggest spender first.
 *
 * A chat that only ever ran ordinary turns has nothing to explain, so a lone
 * `chat` origin is left out rather than restating the call count.
 */
function breakdownLabel(byOrigin: UsageOriginTotals[]) {
  const meaningful = byOrigin.filter((entry) => entry.calls > 0);
  if (meaningful.length <= 1 && meaningful[0]?.origin === "chat") {
    return undefined;
  }
  return meaningful
    .map((entry) => `${entry.label.toLocaleLowerCase()} ${entry.calls}`)
    .join(" · ");
}

/**
 * The proportion of a total that has to be re-read context before saying so.
 *
 * Below this the split is noise. Above it the raw number misleads: it is
 * mostly the same conversation counted once per call.
 */
const CACHED_SHARE_WORTH_NAMING = 0.4;

/**
 * Re-read context, when it is enough of the total to explain the total.
 *
 * Estimated calls carry no cache reading at all, so an unmeasured provider
 * never reaches the threshold and never claims a split it cannot know.
 */
function cachedShare(totals: SessionUsageTotals) {
  const cached = totals.cachedInputTokens;
  if (!Number.isFinite(cached) || cached <= 0 || totals.totalTokens <= 0) {
    return 0;
  }
  return cached / totals.totalTokens >= CACHED_SHARE_WORTH_NAMING ? cached : 0;
}

/**
 * Turn a session's ledger totals into the one line the chat surface shows.
 *
 * Measured and estimated calls are never blended into a single confident
 * number: when any call was estimated, the line says so. An unmeasured
 * provider is counted, but it is not presented as if it had been measured.
 */
export function summarizeSessionCost(
  totals: SessionUsageTotals | undefined,
): SessionCostSummary {
  if (!totals || totals.calls === 0) {
    return {
      isEmpty: true,
      label: "No provider calls yet",
      title: "This chat has not spent anything yet.",
    };
  }

  const tokenLabel = formatTokenCount(totals.totalTokens);
  const label = `${tokenLabel} tokens · ${pluralize(totals.calls, "call")}`;
  const breakdown = breakdownLabel(totals.byOrigin);
  const cachedTokens = cachedShare(totals);
  const cachedNote = cachedTokens
    ? `${formatTokenCount(cachedTokens)} re-read`
    : undefined;
  const estimateNote =
    totals.estimatedCalls > 0
      ? totals.measuredCalls > 0
        ? `${totals.estimatedCalls} estimated`
        : "estimated"
      : undefined;

  const titleParts = [
    `This chat: ${tokenLabel} tokens across ${pluralize(totals.calls, "provider call")}.`,
  ];
  if (breakdown) {
    titleParts.push(`Breakdown: ${breakdown}.`);
  }
  if (cachedTokens) {
    titleParts.push(
      `${formatTokenCount(cachedTokens)} of that was context re-read on each call rather than sent fresh, so the total is larger than the work these calls did.`,
    );
  }
  if (estimateNote) {
    titleParts.push(
      totals.measuredCalls > 0
        ? `${totals.estimatedCalls} of those calls came from providers that report no token counts, so their share is estimated.`
        : "This provider reports no token counts, so the total is estimated.",
    );
  }

  return {
    breakdown,
    cachedNote,
    estimateNote,
    isEmpty: false,
    label,
    title: titleParts.join(" "),
  };
}

/**
 * Whether a single turn's spend is worth flagging.
 *
 * Used by the composer to notice a turn that cost far more than this chat's
 * norm — the first signal that something is running away.
 */
export function isOutsizedTurn(
  turnTokens: number,
  totals: SessionUsageTotals | undefined,
) {
  if (!totals || totals.calls < 3 || turnTokens <= 0) return false;
  const average = totals.totalTokens / totals.calls;
  return average > 0 && turnTokens > average * 3;
}

/** One measured window in the Usage Limits panel. */
export type LedgerWindowView = {
  id: "five-hour" | "week";
  label: string;
  /** Always present: the proportion this window has used of its limit. */
  percent: number;
  /** `41%`, or `<1%` when spend has started but rounds to nothing. */
  percentLabel: string;
  /** `412K of 2M` — the numbers behind the percentage. */
  detail: string;
  /** Whether the limit is a configured budget rather than the reference. */
  hasBudget: boolean;
  /** Where the spend went, biggest first, already labelled. */
  origins: Array<{ label: string; tokens: string; share: number }>;
  isEstimated: boolean;
};

type LedgerWindowSpec = {
  id: "five-hour" | "week";
  label: string;
  /** Length of the rolling window, in hours. */
  hours: number;
  totalsKey: "fiveHour" | "week";
};

/**
 * Which measured windows to show for a provider.
 *
 * Matches how that account is actually limited:
 * - OpenAI / Anthropic: 5-hour session + weekly
 * - xAI (Grok Build): weekly only
 * - Kimi / Gemini and others: weekly only (no known 5h plan meter)
 */
export function ledgerWindowSpecsForProvider(
  providerId: string | undefined,
): LedgerWindowSpec[] {
  switch (providerId) {
    case "openai":
    case "anthropic":
      return [
        {
          hours: 5,
          id: "five-hour",
          label: "5-hour window",
          totalsKey: "fiveHour",
        },
        {
          hours: 24 * 7,
          id: "week",
          label: "Weekly window",
          totalsKey: "week",
        },
      ];
    case "xai":
      return [
        {
          hours: 24 * 7,
          id: "week",
          label: "Weekly window",
          totalsKey: "week",
        },
      ];
    case "kimi":
    case "gemini":
    default:
      return [
        {
          hours: 24 * 7,
          id: "week",
          label: "Weekly window",
          totalsKey: "week",
        },
      ];
  }
}

/** Short copy for the measured panel header, based on which windows apply. */
export function ledgerWindowsCaption(providerId: string | undefined) {
  const specs = ledgerWindowSpecsForProvider(providerId);
  if (specs.length === 0) return "Local spend";
  if (specs.length === 1) {
    return `Spend in the ${specs[0]!.label.toLowerCase()}`;
  }
  const labels = specs.map((spec) =>
    spec.id === "five-hour" ? "5-hour" : "weekly",
  );
  return `Spend in the ${labels.join(" and ")} windows`;
}

/**
 * Turn a provider's ledger totals into the windows Settings shows.
 *
 * Window set is provider-specific (see `ledgerWindowSpecsForProvider`). Percent
 * is spend that builds up in the window (used / limit), not remaining capacity.
 */
export function ledgerWindows(
  summary: ProviderLedgerSummary | undefined,
  providerId?: ProviderId | string,
): LedgerWindowView[] {
  if (!summary) return [];
  const reference = Math.max(1, summary.dailyReferenceTokens);
  const budgetHours = Math.max(1, summary.budget?.windowHours ?? 24);
  const budgetMax = summary.budget?.maxTokens ?? 0;
  const resolvedProviderId = providerId ?? summary.providerId;

  return ledgerWindowSpecsForProvider(resolvedProviderId).map((spec) => {
    const totals =
      spec.totalsKey === "fiveHour" ? summary.fiveHour : summary.week;
    const biggest = totals.byOrigin[0]?.totalTokens ?? 0;
    // Scale the daily reference (or a configured budget) to this window's length.
    const hasBudget = budgetMax > 0;
    const limit = hasBudget
      ? Math.max(1, Math.round((budgetMax * spec.hours) / budgetHours))
      : Math.max(1, Math.round((reference * spec.hours) / 24));
    const percent = Math.min(
      100,
      Math.round((totals.totalTokens / limit) * 100),
    );
    return {
      detail: `${formatTokenCount(totals.totalTokens)} of ${formatTokenCount(limit)}`,
      hasBudget,
      id: spec.id,
      isEstimated: totals.estimatedCalls > 0,
      label: spec.label,
      origins: totals.byOrigin.slice(0, 4).map((origin) => ({
        label: origin.label,
        share: biggest > 0 ? Math.round((origin.totalTokens / biggest) * 100) : 0,
        tokens: formatTokenCount(origin.totalTokens),
      })),
      percent,
      percentLabel:
        totals.totalTokens > 0 && percent === 0 ? "<1%" : `${percent}%`,
    };
  });
}

/** The banner shown when Gyro is holding runs or a budget is running out. */
export type UsageSafetyNotice = {
  tone: "paused" | "warning";
  title: string;
  detail?: string;
  /** Whether the user can lift this themselves right now. */
  canResume: boolean;
};

/** The points at which a measured plan allowance becomes worth interrupting for. */
export const PLAN_USAGE_NOTICE_THRESHOLDS = [50, 80, 90, 95] as const;

export type PlanUsageNotice = {
  providerId: ProviderId;
  windowId: string;
  windowLabel: string;
  percent: number;
  threshold: (typeof PLAN_USAGE_NOTICE_THRESHOLDS)[number];
  /** A new reset timestamp starts a new notification cycle. */
  cycleId: string;
};

/**
 * Return the highest reached threshold for each provider allowance window.
 * Callers persist the returned cycle/threshold pair after presenting it, which
 * keeps a refreshed usage response from repeating the same interruption.
 */
export function planUsageNotices(
  providerId: ProviderId,
  windows: ProviderUsageWindow[],
): PlanUsageNotice[] {
  return windows
    .flatMap((window) => {
      const percent = window.usedPercent;
      if (percent === undefined || !Number.isFinite(percent)) return [];
      const threshold = [...PLAN_USAGE_NOTICE_THRESHOLDS]
        .reverse()
        .find((value) => percent >= value);
      if (!threshold) return [];
      return [{
        cycleId: window.resetsAt ?? "rolling",
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        providerId,
        threshold,
        windowId: window.id,
        windowLabel: window.label,
      }];
    })
    .sort((left, right) => right.threshold - left.threshold);
}

function budgetHeadline(budget: BudgetState) {
  const used = formatTokenCount(budget.usedTokens);
  const cap = formatTokenCount(budget.maxTokens);
  const estimate = budget.hasEstimates ? ", partly estimated" : "";
  return `${budget.providerId}: ${budget.percent}% of budget used (${used} of ${cap}${estimate})`;
}

/**
 * Turn the pause and the budgets into the one thing worth saying.
 *
 * A pause outranks a budget warning, and the worst budget outranks the rest:
 * the banner exists to explain why work stopped, not to list every number.
 */
export function summarizeUsageSafety(
  snapshot: UsageSafetySnapshot | undefined,
): UsageSafetyNotice | undefined {
  if (!snapshot) return undefined;

  const { pause } = snapshot;
  if (pause.active) {
    const isBudget = pause.reason?.kind === "budgetExhausted";
    const resumesAt = pause.autoResumeAt
      ? new Date(pause.autoResumeAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : undefined;
    return {
      canResume: true,
      detail: isBudget
        ? resumesAt
          ? `Runs resume on their own at ${resumesAt}, or resume now to keep going.`
          : "Resume to keep going."
        : undefined,
      title:
        pause.scope === "automations"
          ? "Automations are paused. Chat still runs."
          : isBudget && pause.reason?.kind === "budgetExhausted"
            ? `Paused: the ${pause.reason.providerId} budget is spent.`
            : "Gyro is paused.",
      tone: "paused",
    };
  }

  const worst = [...snapshot.budgets]
    .filter((budget) => budget.level === "throttle" || budget.level === "notify")
    .sort((left, right) => right.percent - left.percent)[0];
  if (!worst) return undefined;

  return {
    canResume: false,
    detail:
      worst.level === "throttle"
        ? "Council runs and automations are on hold until it frees up. Ordinary turns still work."
        : undefined,
    title: budgetHeadline(worst),
    tone: "warning",
  };
}

/** What one press of the send button is about to buy. */
export type TurnCostEstimate = {
  /** Provider calls this send will make. A Council turn is its seats plus one. */
  calls: number;
  /** Estimated tokens across those calls. */
  tokens: number;
  /** `5×` — how this compares with an ordinary single-model turn. */
  multiplier: number;
  /** `5 calls · ~900K tokens · 5× a normal turn`. */
  label: string;
  /** Whether the user should have to agree before this is spent. */
  needsConfirm: boolean;
  /** Plain-language reason, shown on the confirm. */
  confirmReason?: string;
};

/**
 * Tokens above which a single send is large enough to be worth confirming even
 * when a chat has no history to compare it against.
 */
const LARGE_TURN_TOKENS = 400_000;

/** Effort levels that multiply reasoning tokens hardest. */
const EXPENSIVE_EFFORTS = new Set(["max", "ultra"]);

/**
 * Estimate what a send will cost, and decide whether to ask first.
 *
 * The multiplier is the part that goes unnoticed: a Council send is its seats
 * plus a synthesis, so one keypress buys five calls at the current context
 * size. Confirmation is required when the send is large in absolute terms,
 * when it pairs fan-out with the most expensive effort levels, or when it
 * dwarfs what this chat has been spending per call so far.
 */
export function estimateTurnCost({
  chatMode,
  contextTokens,
  reasoningEffort,
  seatCount,
  sessionTotals,
}: {
  chatMode: "normal" | "plan" | "council";
  /** Tokens the next call will carry, from the composer's context meter. */
  contextTokens: number;
  reasoningEffort?: string;
  /** Council seats resolved for this turn. */
  seatCount?: number;
  sessionTotals?: SessionUsageTotals;
}): TurnCostEstimate {
  const seats = chatMode === "council" ? Math.max(0, seatCount ?? 0) : 0;
  // Seats each carry the frozen context; the synthesizer then reads their
  // answers, which is smaller but not free.
  const calls = seats > 0 ? seats + 1 : 1;
  const perCallTokens = Math.max(0, Math.round(contextTokens));
  const tokens =
    seats > 0
      ? perCallTokens * seats + Math.round(perCallTokens * 0.4)
      : perCallTokens;
  const multiplier = calls;

  const isExpensiveEffort = Boolean(
    reasoningEffort && EXPENSIVE_EFFORTS.has(reasoningEffort),
  );
  const averagePerCall =
    sessionTotals && sessionTotals.calls > 0
      ? sessionTotals.totalTokens / sessionTotals.calls
      : 0;
  const dwarfsHistory =
    (sessionTotals?.calls ?? 0) >= 3 &&
    averagePerCall > 0 &&
    tokens > averagePerCall * 3;

  let confirmReason: string | undefined;
  if (seats > 0 && isExpensiveEffort) {
    confirmReason = `${calls} models at ${reasoningEffort} effort is the most expensive turn Gyro can run.`;
  } else if (tokens >= LARGE_TURN_TOKENS && calls > 1) {
    confirmReason = `This one send runs ${calls} provider calls, about ${formatTokenCount(tokens)} tokens.`;
  } else if (dwarfsHistory) {
    confirmReason = `This send is about ${Math.round(tokens / averagePerCall)}× what a call in this chat has been costing.`;
  } else if (tokens >= LARGE_TURN_TOKENS * 2) {
    confirmReason = `This send carries about ${formatTokenCount(tokens)} tokens.`;
  }

  const labelParts = [
    `${calls} ${calls === 1 ? "call" : "calls"}`,
    `~${formatTokenCount(tokens)} tokens`,
  ];
  if (multiplier > 1) {
    labelParts.push(`${multiplier}× a normal turn`);
  }

  return {
    calls,
    confirmReason,
    label: labelParts.join(" · "),
    multiplier,
    needsConfirm: Boolean(confirmReason),
    tokens,
  };
}
