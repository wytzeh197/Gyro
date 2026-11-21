// Fixture: the real chat composer in Council mode, with the final-answer
// ("answered by") picker. Sample data only; no IPC/provider calls.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  normalizedCouncilConfig,
  parseCouncilSynthesizerAction,
  providersForConfig,
  type ChatMode,
  type BrowserTraceRuntime,
  type ChatCompanionTabId,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const query = new URLSearchParams(location.search);
const connected = ["anthropic", "openai", "antigravity"];
const empty: GyroConfig = { commandProfiles: [], modelProviders: [], telemetryEnabled: false, requireCommandApproval: false, requireFileEditApproval: false };
const initial: GyroConfig = {
  ...empty,
  selectedProviderId: "anthropic",
  modelProviders: providersForConfig(empty).map((p) => connected.includes(p.id) ? { ...p, enabled: true, authStatus: "connected" } : p),
  council: { ...normalizedCouncilConfig(undefined), enabled: true, activePresetIds: ["backend"] },
};

// ?live=1: a Council turn mid-run (two seats answering, one done).
const at = "2026-11-20T10:00:00.000Z";
const ev = (id: string, kind: SessionEvent["kind"], payload: Record<string, unknown>): SessionEvent =>
  ({ id, sessionId: "fixture", createdAt: at, kind, message: "", payload: { councilRunId: "c1", ...payload } }) as SessionEvent;
const liveEvents: SessionEvent[] = query.get("live")
  ? [
      ev("e1", "council-run-started", { presetId: "backend", seatProviderIds: ["anthropic", "openai", "antigravity"] }),
      ev("e2", "council-seat-started", { seatId: "s1", providerId: "anthropic" }),
      ev("e3", "council-seat-started", { seatId: "s2", providerId: "openai" }),
      ev("e4", "council-seat-started", { seatId: "s3", providerId: "antigravity" }),
      ev("e5", "council-seat-completed", { seatId: "s2", status: "done" }),
      ...(query.get("live") === "2"
        ? [ev("e6", "council-seat-completed", { seatId: "s1", status: "done" }), ev("e7", "council-seat-completed", { seatId: "s3", status: "done" }), ev("e8", "council-synthesis-started", { synthesizerProviderId: "anthropic" })]
        : []),
    ]
  : [];

function Fixture() {
  const [envOpen, setEnvOpen] = useState(query.has("env"));
  const [config, setConfig] = useState(initial);
  const [mode, setMode] = useState<ChatMode>((query.get("mode") as ChatMode) ?? "council");
  const [sticky, setSticky] = useState(false);
  return (
    <ChatSurface
      councilScope={sticky ? "chat" : undefined}
      config={config}
      events={liveEvents}
      isEnvironmentRailOpen={envOpen}
      onToggleEnvironmentRail={() => setEnvOpen((v) => !v)}
      paneKey="council"
      sessionTitle="Council composer preview"
      workspacePath="/fixture/Gyro"
      sessionModel={{ providerId: "anthropic", modelId: "claude-opus-5-5" }}
      chatMode={mode}
      onComposerAction={(action) => {
        if (action === "set-chat-mode-council") setMode("council");
        if (action === "set-chat-mode-normal") { setMode("normal"); setSticky(false); }
        if (action === "council-scope-chat") setSticky(true);
        if (action === "council-scope-turn") setSticky(false);
        if (action.startsWith("council-toggle-preset:")) {
          const id = action.slice("council-toggle-preset:".length);
          setConfig((c) => {
            const council = normalizedCouncilConfig(c.council);
            const ids = council.activePresetIds ?? [];
            return { ...c, council: { ...council, activePresetIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] } };
          });
        }
        const writer = parseCouncilSynthesizerAction(action);
        if (writer !== undefined) setConfig((c) => ({ ...c, council: { ...normalizedCouncilConfig(c.council), synthesizer: writer } }));
      }}
      onSend={() => undefined}
      shellReady
    />
  );
}

// The app sets the theme on <html>; composer resets key off `:root[data-theme]`.
document.documentElement.dataset.theme = "dark";
const traceEvidence = {click:"Save",events:[{id:1,kind:"request" as const,elapsedMs:35,method:"POST",origin:"http://localhost:3000",path:"/api/events",status:400}]};
const traceExcerpt = {id:1,path:"src/events.ts",firstLine:42,selectedLine:42,lines:["if (!startTime) return 400;"],hash:"fixture"};
function TraceFixture() {
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<ChatCompanionTabId>();
  const [tabs, setTabs] = useState<ChatCompanionTabId[]>([]);
  const data = useState(() => ({sends:0, analyzed:0, source:0, setup:undefined as Parameters<BrowserTraceRuntime["start"]>[0] | undefined}))[0];
  Object.assign(window, {traceFixture: data});
  const chooseTab = (next: ChatCompanionTabId) => { setTab(next); setTabs(current => current.includes(next) ? current : [...current, next]); };
  const runtime: BrowserTraceRuntime = {
    sessionId:"trace-fixture", roots:[{id:"calendar",path:"/fixture/Calendar"}], activeRootId:"calendar",
    active:async()=>null,
    start:async (setup)=>{data.setup=setup;return "capture";},
    status:async()=>({done:true,evidence:traceEvidence,browserModel:data.setup?.browserModel,sourceModel:data.setup?.sourceModel}),
    discard:async()=>{},
    review:async()=>({id:"approval",browserInput:{question:data.setup!.question,evidence:traceEvidence},sourceInput:{question:data.setup!.question,evidence:traceEvidence,source:[traceExcerpt]},excerpts:[traceExcerpt]}),
    analyze:async()=>{data.analyzed++;return {id:"trace",setup:data.setup!,evidence:traceEvidence,approvedEvidence:traceEvidence,excerpts:[traceExcerpt],browserFindings:[],sourceFindings:[{text:"The handler requires a start time for all-day events.",eventId:1,excerptId:1,line:42}],errors:[]};},
    history:async()=>[],
    openSource:async()=>{data.source++;return false;},
  };
  return <ChatSurface config={initial} events={[]} draft={draft} onDraftChange={setDraft}
    onSend={()=>{data.sends++;}} shellReady workspacePath="/fixture/Calendar"
    sessionModel={{providerId:"anthropic",modelId:"claude-opus-5-5"}} browserTrace={runtime}
    browserPreview={{url:"http://localhost:3000", history:[], historyIndex:-1, device:"desktop", status:"ready", consoleErrors:0, diagnostics:[], diagnosticsSupported:true, diagnosticsCaptured:false, captureStatus:"idle", verificationMessage:""}}
    activeChatPanel={tab} companionTabs={tabs} onOpenCompanionTab={chooseTab} onCloseCompanionDock={()=>setTab(undefined)} />;
}

createRoot(document.getElementById("root")!).render(
  <main className="gyro-app" data-theme="dark" style={{ height: "100vh", display: "flex", background: "var(--gyro-pane)" }}>{query.has("trace") ? <TraceFixture /> : <Fixture />}</main>,
);
