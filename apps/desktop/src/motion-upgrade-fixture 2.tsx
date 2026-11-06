// Standalone production-component fixture. No desktop IPC or live provider calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatSurface, SizingMotionFixture, type ChatSidePanelId, type GyroConfig, type SessionEvent } from "@gyro-dev/ui";
import { ChatRun, MotionDisclosure, type RunModel } from "@gyro-dev/ui";
import { BranchNameDialog } from "./branch-name-dialog";
import "@gyro-dev/ui/styles.css";
import "./motion-upgrade-fixture.css";

document.documentElement.dataset.theme = "dark";
const config: GyroConfig = { modelProviders: [], commandProfiles: [], telemetryEnabled: false, requireFileEditApproval: true, requireCommandApproval: true };
const events: SessionEvent[] = [
  { id: "motion-request", sessionId: "motion-qa", turnId: "motion-turn", kind: "user-message", createdAt: "2026-10-12T08:00:00Z", message: "Make Gyro feel quick and smooth.", payload: {} },
  { id: "motion-answer", sessionId: "motion-qa", turnId: "motion-turn", kind: "assistant-message", createdAt: "2026-10-12T08:00:01Z", message: "Use the fixture controls to open, close, resize, and interrupt the actual companion panel.", payload: {} },
];
const run: RunModel = {
  phase: { name: "done", durationMs: 12000 }, startedAt: "2026-10-12T08:00:00Z", files: [],
  steps: Array.from({ length: 4 }, (_, i) => ({ kind: "work" as const, id: `read-${i}`, at: "2026-10-12T08:00:01Z", item: { kind: "read" as const, id: `read-${i}`, status: "done" as const, media: "file" as const, path: `src/component-${i}.tsx` } })),
};
function sample(selector: string, duration = 300) {
  return new Promise<{ frames: number; intermediate: number; heights: number; mounted: boolean }>((resolve) => {
    let frames = 0, intermediate = 0;
    const heights = new Set<number>();
    const start = performance.now();
    function frame() {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
        frames++;
        heights.add(Math.round(element.getBoundingClientRect().height * 100) / 100);
        const style = getComputedStyle(element);
        const opacity = Number(style.opacity);
        if ((opacity > 0.001 && opacity < 0.999) || element.getAnimations().some((a) => a.playState === "running")) intermediate++;
      }
      if (performance.now() - start < duration) requestAnimationFrame(frame);
      else resolve({ frames, intermediate, heights: heights.size, mounted: Boolean(document.querySelector(selector)) });
    }
    requestAnimationFrame(frame);
  });
}
function Fixture() {
  const [panel, setPanel] = useState<ChatSidePanelId>();
  const [width, setWidth] = useState(390);
  const [draft, setDraft] = useState("");
  const [dialog, setDialog] = useState(false);
  const [detail, setDetail] = useState(false);
  const [result, setResult] = useState("Not run");
  const [busy, setBusy] = useState(false);
  async function verifyDisclosure() {
    setBusy(true);
    flushSync(() => setDetail(true));
    const opened = await sample("[data-disclosure-fixture] .gyro-motion-disclosure");
    flushSync(() => setDetail(false));
    const closed = await sample("[data-disclosure-fixture] .gyro-motion-disclosure");
    flushSync(() => setDetail(true));
    await sample("[data-disclosure-fixture] .gyro-motion-disclosure", 35);
    flushSync(() => setDetail(false));
    await sample("[data-disclosure-fixture] .gyro-motion-disclosure", 35);
    flushSync(() => setDetail(true));
    const reversed = await sample("[data-disclosure-fixture] .gyro-motion-disclosure");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const passed = opened.mounted && !closed.mounted && reversed.mounted && (reduced || (opened.intermediate > 0 && closed.intermediate > 0 && opened.heights > 1 && closed.heights > 1));
    setResult(`${passed ? "PASS" : "FAIL"} disclosure: open ${opened.intermediate} moving frames; close ${closed.intermediate} moving frames; removed after close ${!closed.mounted}; reversal settled ${reversed.mounted}; reduced motion ${reduced}`);
    setBusy(false);
  }
  return <main className="gyro-motion-upgrade">
    <header className="motion-qa-header"><div><h1>Gyro motion upgrade</h1><p>Standalone QA · actual components · fixture data</p></div>
      <nav><a href="/browser-pointer-fixture.html">AI cursor fixture</a><a href="/sizing-motion.html">Controls fixture</a><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"}>Toggle theme</button></nav>
    </header>
    <section className="motion-qa-tools" aria-label="Motion preview controls">
      <button onClick={() => setPanel("files")}>Open Files panel</button>
      <button onClick={() => setPanel("canvas")}>Open Canvas panel</button>
      <button onClick={() => setPanel(undefined)}>Close panel</button>
      <button onClick={() => { setPanel("files"); setTimeout(() => setPanel(undefined), 55); setTimeout(() => setPanel("files"), 110); }}>Reverse panel quickly</button>
      <button onClick={() => setDialog(true)}>Open branch dialog</button>
      <output>Panel state: {panel ?? "closed"}</output>
    </section>
    <section className="motion-qa-chat" aria-label="Production chat and companion fixture">
      <ChatSurface config={config} events={events} draft={draft} onDraftChange={setDraft} onSend={() => {}} shellReady
        activeChatPanel={panel} companionTabs={["files", "canvas"]} onOpenCompanionTab={setPanel} onSelectChatPanel={setPanel}
        onCloseCompanionDock={() => setPanel(undefined)} onCloseCompanionTab={() => setPanel(undefined)}
        companionWidth={width} onCompanionWidthChange={setWidth} workspacePath="/fixture/gyro"
        files={[{ path: "/fixture/gyro/src", relativePath: "src", kind: "directory", depth: 0 }, { path: "/fixture/gyro/src/components.tsx", relativePath: "src/components.tsx", kind: "file", depth: 1 }]} />
    </section>
    <section className="motion-qa-detail">
      <h2>Activity details</h2><p>Open the finished run, then expand its file group. Close during movement to check reversal.</p>
      <ChatRun model={run} layout="groups" />
      <div data-disclosure-fixture><button aria-expanded={detail} onClick={() => setDetail(!detail)}>Toggle measured disclosure</button>
        <MotionDisclosure open={detail}><div className="motion-qa-disclosure-content"><p>Real shared disclosure component.</p><button>Focusable detail action</button><p>It grows and collapses, then removes hidden content.</p></div></MotionDisclosure>
      </div>
      <button disabled={busy} onClick={() => void verifyDisclosure()}>Run disclosure frame checks</button>
      <output aria-live="polite" data-motion-result>{result}</output>
    </section>
    <SizingMotionFixture />
    {dialog ? <BranchNameDialog initialValue="feature/smooth-motion" onFinish={() => setDialog(false)} /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
