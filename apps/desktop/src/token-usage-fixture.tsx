// Standalone fixtures of the actual ChatSurface. No native IPC or provider calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, type GyroConfig, type SessionEvent, type TurnTokens, type UsageAccounting } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
const accounting = (coverage: UsageAccounting["coverage"], overrides: Partial<UsageAccounting> = {}): UsageAccounting => ({
  source: "provider", scope: "task", coverage,
  known: { input: true, output: true, cacheRead: false, cacheWrite: false, reasoning: false },
  ...overrides,
});
const cases: Record<string, { title: string; message: string; tokens: TurnTokens }> = {
  complete: { title: "Reported", message: "The provider reported the complete total for this turn.",
    tokens: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, measured: true, accounting: accounting("complete") } },
  partial: { title: "Partial", message: "This resumed turn has no verified starting count. The footer shows the observed lower bound.",
    tokens: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540, measured: false, accounting: accounting("partial", { reason: "missing-baseline" }) } },
  estimated: { title: "Estimated", message: "The runtime did not report usage. This reading estimates only observed text.",
    tokens: { inputTokens: 100, outputTokens: 25, totalTokens: 125, measured: false, accounting: accounting("estimated", { source: "character-estimate", reason: "missing-usage" }) } },
  unavailable: { title: "Unavailable", message: "This runtime does not expose enough data to count the turn.",
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, measured: false, accounting: accounting("unavailable", { reason: "unsupported-runtime" }) } },
  zero: { title: "Reported zero", message: "The provider explicitly reported zero usage. Missing usage would have a different label.",
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, measured: true, accounting: accounting("complete") } },
  failed: { title: "Cancelled turn", message: "The turn stopped after consuming tokens.",
    tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 120, measured: false, accounting: accounting("partial", { reason: "interrupted" }) } },
  cached: { title: "Cache and reasoning", message: "Cache reads and writes are included in input. Reasoning is included in output.",
    tokens: { inputTokens: 1200, cachedInputTokens: 800, cacheWriteTokens: 100, outputTokens: 340, reasoningOutputTokens: 40, totalTokens: 1540, measured: true,
      accounting: accounting("complete", { known: { input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true } }) } },
};
const config: GyroConfig = { commandProfiles: [], modelProviders: [], requireCommandApproval: true, requireFileEditApproval: true, telemetryEnabled: false };
function Fixture() {
  const requested = new URLSearchParams(location.search).get("case") ?? "complete";
  const [selected, setSelected] = useState(requested in cases ? requested : "complete");
  const [corrected, setCorrected] = useState(false);
  const [draft, setDraft] = useState("");
  const current = cases[selected]!;
  const createdAt = "2026-10-10T00:00:00.000Z";
  const events: SessionEvent[] = [
    { id: "fixture-user", sessionId: "token-fixture", turnId: "fixture-turn", kind: "user-message", createdAt,
      message: "Show the token accounting state for this reply.", payload: {} },
    ...(selected === "failed" ? [
      { id: "fixture-failed-receipt", sessionId: "token-fixture", turnId: "fixture-turn", kind: "system-event" as const, createdAt,
        message: "", payload: { kind: "provider-turn-tokens", turnTokens: current.tokens } },
      { id: "fixture-failed", sessionId: "token-fixture", turnId: "fixture-turn", kind: "system-event" as const, createdAt,
        message: "Provider chat cancelled", payload: { kind: "provider-run", runId: "fixture-turn", status: "cancelled" } },
    ] : [{ id: "fixture-answer", sessionId: "token-fixture", turnId: "fixture-turn", kind: "assistant-message" as const, createdAt,
      message: current.message, payload: { turnTokens: current.tokens } }]),
    ...(corrected ? [{ id: "fixture-revision", sessionId: "token-fixture", turnId: "fixture-turn", kind: "system-event" as const,
      createdAt: "2026-10-10T00:00:01.000Z", message: "", payload: { kind: "provider-turn-tokens",
        turnTokens: { inputTokens: 1600, outputTokens: 400, totalTokens: 2000, measured: true, accounting: accounting("complete") } } }] : []),
  ];
  return <>
    <aside aria-label="Token accounting fixture controls" style={{ position: "fixed", top: 10, right: 18, zIndex: 10000, display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderRadius: 8, background: "var(--gyro-surface)", color: "var(--gyro-text)", border: "1px solid var(--gyro-border)", fontSize: 12 }}>
      <span>Fixture · Token accounting</span>
      <select aria-label="Accounting state" value={selected} onChange={event => { setSelected(event.target.value); setCorrected(false); }}>
        {Object.entries(cases).map(([id, item]) => <option key={id} value={id}>{item.title}</option>)}
      </select>
      <button type="button" aria-label="Next accounting state" onClick={() => {
        const ids = Object.keys(cases); setSelected(ids[(ids.indexOf(selected) + 1) % ids.length]!); setCorrected(false);
      }}>Next</button>
      <button type="button" onClick={() => setCorrected(true)}>Apply late receipt</button>
      {corrected && <output aria-live="polite">Corrected total: 2,000</output>}
    </aside>
    <ChatSurface key={selected} events={events} config={config} draft={draft} onDraftChange={setDraft}
      sessionUsage={{ calls: 1, measuredCalls: corrected || current.tokens.measured ? 1 : 0,
        estimatedCalls: !corrected && selected === "estimated" ? 1 : 0,
        partialCalls: !corrected && ["partial", "failed"].includes(selected) ? 1 : 0,
        unavailableCalls: !corrected && selected === "unavailable" ? 1 : 0,
        inputTokens: corrected ? 1600 : current.tokens.inputTokens ?? 0,
        cachedInputTokens: current.tokens.cachedInputTokens ?? 0,
        outputTokens: corrected ? 400 : current.tokens.outputTokens ?? 0,
        totalTokens: corrected ? 2000 : current.tokens.totalTokens, byOrigin: [] }}
      shellReady onSend={() => {}} onBrowserNavigate={() => {}} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
