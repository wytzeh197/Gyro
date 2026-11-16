import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSegmented,
} from "./settings-controls";
import type { ProviderLedgerSummary } from "./types";
import { formatTokenCount } from "./usage-ledger";
import "./usage-settings.css";

const pages = [
  { id: "usage", label: "Usage" },
  { id: "tokens", label: "Tokens" },
] as const;
type UsagePage = (typeof pages)[number]["id"];

/** Keep both panels mounted so settings search can reveal a target in either. */
export function UsageSettingsPages({
  providerControl,
  usage,
  tokens,
}: {
  providerControl: ReactNode;
  usage: ReactNode;
  tokens: ReactNode;
}) {
  const [page, setPage] = useState<UsagePage>("usage");
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const element = root.current;
    const reveal = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const panel = target.closest<HTMLElement>("[data-usage-page]");
      if (
        panel?.dataset.usagePage === "usage" ||
        panel?.dataset.usagePage === "tokens"
      )
        setPage(panel.dataset.usagePage);
    };
    element?.addEventListener("gyro:reveal-setting", reveal);
    return () => element?.removeEventListener("gyro:reveal-setting", reveal);
  }, []);
  return (
    <div className="gyro-usage-settings" ref={root}>
      <div
        className="gyro-usage-subnav"
        role="tablist"
        aria-label="Usage & limits"
      >
        {pages.map((item, index) => (
          <button
            key={item.id}
            id={`${id}-${item.id}-tab`}
            type="button"
            role="tab"
            aria-selected={page === item.id}
            aria-controls={`${id}-${item.id}-panel`}
            tabIndex={page === item.id ? 0 : -1}
            onClick={() => setPage(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? pages.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % pages.length
                      : event.key === "ArrowLeft"
                        ? (index + pages.length - 1) % pages.length
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setPage(pages[next]!.id);
              root.current
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="gyro-usage-scope">{providerControl}</div>
      {pages.map((item) => (
        <div
          key={item.id}
          id={`${id}-${item.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${item.id}-tab`}
          data-usage-page={item.id}
          hidden={page !== item.id}
          tabIndex={0}
        >
          {item.id === "usage" ? usage : tokens}
        </div>
      ))}
    </div>
  );
}

export function TokenUsageSummary({
  ledger,
}: {
  ledger?: ProviderLedgerSummary;
}) {
  const [period, setPeriod] = useState<"fiveHour" | "day" | "week">("week");
  const totals = ledger?.[period];
  const incomplete = Boolean(
    totals && (totals.partialCalls ?? 0) + (totals.unavailableCalls ?? 0) > 0,
  );
  const estimated = Boolean(totals?.estimatedCalls);
  const hasCounts = Boolean(
    totals &&
    totals.measuredCalls + totals.estimatedCalls + (totals.partialCalls ?? 0) >
      0,
  );
  return (
    <SettingsGroup
      id="recorded-tokens"
      label="Recorded tokens"
      description="Token counts observed by Gyro on this device."
      collapsible={false}
      actions={
        <SettingsSegmented
          label="Token period"
          value={period}
          options={[
            { label: "5 hours", value: "fiveHour" },
            { label: "24 hours", value: "day" },
            { label: "7 days", value: "week" },
          ]}
          onChange={setPeriod}
        />
      }
    >
      {!totals ? (
        <SettingsEmptyState
          title="Token data unavailable"
          description="Recorded token counts appear here after a provider run."
        />
      ) : totals.calls === 0 ? (
        <SettingsEmptyState
          title="No usage in this period"
          description="Try a longer period or start a chat with this provider."
        />
      ) : (
        <>
          <div className="gyro-token-total">
            <div>
              <strong>
                {hasCounts ? formatTokenCount(totals.totalTokens) : "—"}
              </strong>
              <span>
                {hasCounts ? "recorded tokens" : "Token counts unavailable"}
              </span>
            </div>
            <p>
              {totals.calls.toLocaleString()}{" "}
              {totals.calls === 1 ? "call" : "calls"}
              {estimated ? " · includes estimates" : ""}
              {incomplete ? " · incomplete coverage" : ""}
            </p>
          </div>
          <dl className="gyro-token-breakdown">
            <div>
              <dt>Input</dt>
              <dd>{hasCounts ? formatTokenCount(totals.inputTokens) : "—"}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{hasCounts ? formatTokenCount(totals.outputTokens) : "—"}</dd>
            </div>
            <div>
              <dt>Cached input</dt>
              <dd>
                {hasCounts ? formatTokenCount(totals.cachedInputTokens) : "—"}
              </dd>
            </div>
          </dl>
          <p className="gyro-usage-footnote">
            Cached input is included in input tokens. Counts do not represent a
            bill or your remaining plan allowance.
          </p>
          {estimated || incomplete ? (
            <p className="gyro-usage-footnote" role="status">
              {totals.measuredCalls} measured · {totals.estimatedCalls}{" "}
              estimated · {totals.partialCalls ?? 0} partial ·{" "}
              {totals.unavailableCalls ?? 0} unavailable calls.
            </p>
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}
