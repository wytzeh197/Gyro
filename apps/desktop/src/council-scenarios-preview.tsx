// Fixture: Council composer states and response cards, picked with ?scenario=.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  normalizedCouncilConfig,
  providersForConfig,
  readyCouncilProviders,
  resolveCouncilSeatRequests,
  toggleCouncilActivePreset,
  parseCouncilSynthesizerAction,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { COUNCIL_TOGGLE_PRESET_ACTION, COUNCIL_WRITER_COPY, CouncilPreflight, councilSynthesizerAction, councilWriterOptions } from "../../../packages/ui/src/council-composer";
import { ComposerReviewerPicker } from "../../../packages/ui/src/composer-reviewer-picker";
import type { ProviderId } from "../../../packages/ui/src/types";
import { AssistantResponse } from "../../../packages/ui/src/surfaces";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "composer";
const theme = params.get("theme") ?? "dark";

function configFor(connected: string[], presets: string[], enabled = true): GyroConfig {
  const base: GyroConfig = { commandProfiles: [], modelProviders: [], requireCommandApproval: false, requireFileEditApproval: false, telemetryEnabled: false };
  return {
    ...base,
    modelProviders: providersForConfig(base).map((p) => connected.includes(p.id) ? { ...p, enabled: true, authStatus: "connected" } : p),
    council: { ...normalizedCouncilConfig(undefined), enabled, activePresetIds: presets },
  };
}

function Composer({ label, initial, enabled = true, pickerOpen = false }: { label: string; initial: GyroConfig; enabled?: boolean; pickerOpen?: boolean }) {
  const [config, setConfig] = useState(initial);
  const [open, setOpen] = useState(pickerOpen);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resolution = resolveCouncilSeatRequests(config, readyCouncilProviders(config));
  const apply = (action: string) => {
    const writer = parseCouncilSynthesizerAction(action);
    if (writer !== undefined) setConfig((c) => ({ ...c, council: { ...normalizedCouncilConfig(c.council), synthesizer: writer } }));
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, color: "var(--gyro-muted)", fontSize: 12, fontWeight: 500 }}>{label}</h3>
      <div style={{ position: "relative", border: "1px solid var(--gyro-border-soft)", borderRadius: 14, padding: "10px 12px", background: "var(--gyro-control-bg)" }}>
        {open && (
          <ComposerReviewerPicker copy={COUNCIL_WRITER_COPY} normalChat options={councilWriterOptions(config)} textarea={textarea}
            selected={config.council?.synthesizer ? { providerId: resolution.synthesizerProviderId as ProviderId, modelId: resolution.synthesizerModelId ?? "", label: resolution.synthesizerModelLabel ?? "" } : undefined}
            onDismiss={() => setOpen(false)}
            onChoose={(o) => { apply(councilSynthesizerAction({ providerId: o.providerId, modelId: o.modelId })); setOpen(false); }}
            onRemove={() => { apply(councilSynthesizerAction()); setOpen(false); }} />
        )}
        <CouncilPreflight config={config} costLabel="~$0.08" costTitle="Estimated from recent turns" enabled={enabled} resolution={resolution}
          onChooseWriter={() => setOpen((v) => !v)}
          onAction={(action) => {
            apply(action);
            if (!action.startsWith(COUNCIL_TOGGLE_PRESET_ACTION)) return;
            const id = action.slice(COUNCIL_TOGGLE_PRESET_ACTION.length);
            setConfig((c) => ({ ...c, council: toggleCouncilActivePreset(normalizedCouncilConfig(c.council), id) }));
          }} />
        <textarea ref={textarea} readOnly value="/council Should the session store move to SQLite?" style={{ marginTop: 10, width: "100%", border: 0, background: "transparent", color: "var(--gyro-muted)", fontSize: 13, resize: "none", font: "inherit" }} rows={1} />
      </div>
    </section>
  );
}

const seat = (id: string, providerId: string, providerLabel: string, modelId: string, status: string, durationMs: number, outputPreview?: string, error?: string) =>
  ({ id, providerId, providerLabel, modelId, status, durationMs, outputPreview, error });

const synthesis = {
  synthesizerProviderId: "anthropic", synthesizerModelId: "claude-opus-5-5",
  unifiedMarkdown: "## Recommendation\nMove the session store to **SQLite in WAL mode**, behind the existing `SessionStore` trait.\n\n**All seats agree**\n- JSON files don't scale past ~5k events per chat.\n- Keep the trait so tests can use an in-memory store.\n\n**Disagreement**\n- GPT prefers a one-shot migration on launch; Gemini wants a lazy, per-chat migration. Lazy is safer for large histories.\n\n**Adoption steps**\n1. Add `rusqlite` with the `bundled` feature.\n2. Write the migration behind a flag.\n3. Ship read-path first, then writes.",
  recommendation: "SQLite (WAL)", agreement: [], disagreements: [], uniqueInsights: [], risksAndTests: [], adoptionSteps: [], durationMs: 6200,
};

function councilEvent(over: Record<string, unknown>, message = ""): SessionEvent {
  return {
    id: "evt-1", sessionId: "session-1", createdAt: new Date().toISOString(), kind: "assistant-message", message,
    payload: {
      kind: "council-response", councilRunId: "run-1", status: "done", presetId: "backend",
      seats: [
        seat("s1", "anthropic", "Anthropic", "claude-opus-5-5", "done", 14200, "Use SQLite with WAL. Keep SessionStore trait…"),
        seat("s2", "openai", "OpenAI", "gpt-5.5", "done", 11800, "SQLite, migrate once at launch…"),
        seat("s3", "gemini", "Google", "gemini-3-pro", "done", 9600, "SQLite, but migrate lazily per chat…"),
      ],
      synthesis, totals: { wallDurationMs: 21400, seatsSucceeded: 3, seatsFailed: 0, estimatedCostUsd: 0.08 },
      ...over,
    },
  } as unknown as SessionEvent;
}

function Card({ label, event }: { label: string; event: SessionEvent }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, color: "var(--gyro-muted)", fontSize: 12, fontWeight: 500 }}>{label}</h3>
      <AssistantResponse event={event} onCouncilAction={async () => "Full seat output would load here."} />
    </section>
  );
}

function Scenario() {
  if (scenario === "composer") {
    return <>
      <Composer label="1 · One preset loaded (Backend)" initial={configFor(["anthropic", "openai", "google"], ["backend"])} />
      <Composer label="2 · Two presets loaded (Backend + Frontend → merged, one seat per provider)" initial={configFor(["anthropic", "openai", "google", "xai"], ["backend", "frontend"])} />
      <Composer label="3 · Only one provider connected → blocked" initial={configFor(["anthropic"], ["backend"])} />
      <Composer label="4 · Council turned off in Settings" initial={configFor(["anthropic", "openai", "google"], ["backend"], false)} enabled={false} />
    </>;
  }
  if (scenario === "writer") {
    const withWriter = configFor(["anthropic", "openai", "google"], ["backend"]);
    withWriter.council = { ...withWriter.council!, synthesizer: { providerId: "openai", modelId: null } };
    return <>
      <Composer label="Right after picking /council · choose who writes the final answer" initial={configFor(["anthropic", "openai", "google"], ["backend"])} pickerOpen />
      <div style={{ height: 400 }} />
      <Composer label="Default · preset's model writes the answer" initial={configFor(["anthropic", "openai", "google"], ["backend"])} />
      <Composer label="Override for this chat · OpenAI writes the answer" initial={withWriter} />
    </>;
  }
  if (scenario === "card") return <Card label="Finished run · 3 of 3 seats" event={councilEvent({})} />;
  if (scenario === "partial") {
    return <Card label="Partial run · one seat failed" event={councilEvent({
      status: "partial",
      seats: [
        seat("s1", "anthropic", "Anthropic", "claude-opus-5-5", "done", 14200, "Use SQLite with WAL…"),
        seat("s2", "openai", "OpenAI", "gpt-5.5", "failed", 30000, undefined, "Rate limited (429). Try again in a minute."),
        seat("s3", "gemini", "Google", "gemini-3-pro", "done", 9600, "SQLite, migrate lazily…"),
      ],
      totals: { wallDurationMs: 30400, seatsSucceeded: 2, seatsFailed: 1 },
    })} />;
  }
  if (scenario === "nosynth") {
    return <Card label="Synthesis failed · seats still readable" event={councilEvent({ status: "partial", synthesis: null }, "The synthesizer did not return an answer.")} />;
  }
  if (scenario === "resynth") {
    return <Card label="Re-synthesized answer" event={councilEvent({ retry: true, presetId: "backend+frontend", synthesis: { ...synthesis, parseWarnings: ["Synthesizer skipped the 'risks' section."] } })} />;
  }
  return null;
}

createRoot(document.getElementById("root")!).render(
  <main className="gyro-app" data-theme={theme} style={{ minHeight: "100vh", padding: 32, background: "var(--gyro-pane)" }}>
    <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: 22 }}><Scenario /></div>
  </main>,
);
