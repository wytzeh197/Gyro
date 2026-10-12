// Actual composer and settings cards; account readings and context are local fixtures.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, UsageCard, providersForConfig, type GyroConfig, type ProviderId, type ProviderUsageWindow, type SessionEvent } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = { commandProfiles: [], modelProviders: [], requireCommandApproval: true, requireFileEditApproval: true, telemetryEnabled: false };
const config: GyroConfig = { ...empty, selectedProviderId:"openai", modelProviders:providersForConfig(empty).filter(p => p.id === "openai").map(p => ({ ...p, enabled:true, authStatus:"connected", defaultModelId:"gpt-6.1-sol" })) };
const scenes: Record<string, { used?: number; status?: ProviderUsageWindow["status"]; context: number; unknownContext?: boolean }> = {
  reported: { used:46, context:32_000 },
  nearlyEmpty: { used:99.6, context:474_900 },
  exhausted: { status:"exhausted", context:475_000 },
  unknown: { context:32_000, unknownContext:true },
  full: { used:0, context:0 },
};
function Preview() {
  const [scene, setScene] = useState("reported");
  const [light, setLight] = useState(true);
  const [draft, setDraft] = useState("");
  const [inspect, setInspect] = useState(false);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const state = scenes[scene]!;
  const resetsAt = new Date(Date.now() + 6 * 86400_000).toISOString();
  const windows: ProviderUsageWindow[] = [{ id:"weekly",label:"Weekly window",usedPercent:state.used,status:state.status,resetsAt }];
  const modelId = state.unknownContext ? "unknown-model" : "gpt-6.1-sol";
  const providerId: ProviderId = state.unknownContext ? "custom:fixture" : "openai";
  const events: SessionEvent[] = [{ id:"fixture-reply",sessionId:"capacity-fixture",turnId:"fixture-turn",kind:"assistant-message",createdAt:new Date().toISOString(),message:"Capacity fixture. Plan readings and context counts are simulated.",payload:{providerId,modelId,contextUsage:{inputTokens:state.context,outputTokens:0,totalTokens:state.context,...(state.unknownContext ? {} : {modelContextWindow:475_000})}} }];
  return <main className={`usage-preview${inspect ? " is-inspecting" : ""}`}>
    <style>{`
      html,body,#root { height:100%; }
      .usage-preview { height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
      .usage-preview *, .usage-preview *::before, .usage-preview *::after { animation:none !important;transition:none !important; }
      .usage-preview > header { display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 18px;border-bottom:1px solid var(--gyro-border);font-size:12px; }
      .usage-preview > header strong { margin-right:auto; }
      .usage-preview > header button, .usage-preview > header select { font:inherit;color:inherit;border:1px solid var(--gyro-border);background:var(--gyro-pane);border-radius:6px;padding:6px 10px; }
      .usage-preview-content { display:grid;grid-template-columns:340px minmax(0,1fr);min-height:0; }
      .usage-preview-cards { padding:24px;overflow:auto;display:grid;align-content:start;gap:22px;border-right:1px solid var(--gyro-border); }
      .usage-preview-cards h2 { margin:0;font-size:13px; }
      .usage-preview-cards p { margin:0;color:var(--gyro-muted);font-size:12px; }
      .usage-preview-chat { min-height:0;min-width:0;position:relative; }
      .usage-preview-chat > .gyro-chat-surface { height:100%; }
      .usage-preview.is-inspecting .gyro-composer-context-tooltip { opacity:1;visibility:visible;transform:none; }
      @media(max-width:800px) { .usage-preview-content { grid-template-columns:260px minmax(0,1fr); } .usage-preview-cards { padding:14px; } }
    `}</style>
    <header>
      <strong>Usage left · context used · actual components / fixture readings</strong>
      <select aria-label="Capacity scenario" value={scene} onChange={e => {setScene(e.target.value);setDraft("");}}>
        <option value="reported">46% spent · 54% left</option><option value="nearlyEmpty">Nearly empty</option><option value="exhausted">Exhausted, no percentage</option><option value="unknown">Unknown limits</option><option value="full">Full allowance</option>
      </select>
      <button onClick={() => setInspect(!inspect)}>Inspect composer meter</button>
      <button onClick={() => setLight(!light)}>{light ? "Dark theme" : "Light theme"}</button>
    </header>
    <div className="usage-preview-content">
      <section className="usage-preview-cards" aria-label="Settings usage fixtures">
        <h2>Settings · bars</h2><UsageCard window={windows[0]} visualization="bars" />
        <h2>Settings · wheels</h2><UsageCard window={windows[0]} visualization="wheels" />
        <p>Plan usage shows what is left. Context shows tokens used. Unknown levels stay unmeasured.</p>
      </section>
      <section className="usage-preview-chat" aria-label="Composer usage fixture">
        <ChatSurface key={scene} events={events} config={config} draft={draft} onDraftChange={setDraft} onSend={() => undefined}
          sessionModel={{providerId,modelId,modelLabel:state.unknownContext ? "Unknown model" : "GPT-6.1 Sol"}}
          providerUsageByProvider={{ [providerId]: {providerId,status:"available" as const,windows,fetchedAt:new Date().toISOString()} }}
          dailyPaceWarning={false} shellReady />
      </section>
    </div>
  </main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);
