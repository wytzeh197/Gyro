// Development-only regression fixture; no provider or workspace actions.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRun, type SessionEvent } from "@gyro-dev/ui";
import { buildRunModel } from "../../../packages/ui/src/chat-run";
import {
  applyProviderChatStreamActivity,
  mergePersistedAndOptimisticEvents,
} from "./provider-stream-events";
import "@gyro-dev/ui/styles.css";

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
function Fixture() {
  const ref = useRef({ current: new Map<string, SessionEvent[]>() }).current;
  const stale = useRef<SessionEvent[]>([]);
  const sequence = useRef(0);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [state, setState] = useState("Ready");
  const emit = (activityId: string, activityStatus: "running" | "done") => {
    applyProviderChatStreamActivity(ref, () => {}, {
      sessionId: "fixture", turnId: "turn", providerId: "openai",
      sequence: ++sequence.current, eventId: `frame-${sequence.current}`,
      phase: "activity", activityId, activityKind: "read",
      activityLabel: "Reading src/app.ts", activityDetail: "src/app.ts", activityStatus,
    });
    setEvents([...ref.current.get("fixture")!]);
  };
  const model = buildRunModel(events, { isRunning: true });
  return <main style={{ padding: "var(--gyro-space-panel)", color: "var(--gyro-text)", background: "var(--gyro-surface)", minHeight: "100vh" }}>
    <p>Tool status fixture · simulated events</p>
    <nav aria-label="Simulated tool updates">
      <button onClick={() => { ref.current.clear(); emit("first", "running"); stale.current = structuredClone(ref.current.get("fixture")!); setState("Running"); }}>Start tool</button>
      <button onClick={() => { emit("first", "done"); setState("Completed"); }}>Finish tool</button>
      <button onClick={() => { emit("first", "running"); setState("Delayed start received"); }}>Replay stale start</button>
      <button onClick={() => {
        const merged = mergePersistedAndOptimisticEvents(stale.current, ref.current.get("fixture"));
        ref.current.set("fixture", merged); setEvents(merged); setState("Stale refresh received");
      }}>Refresh stale history</button>
      <button onClick={() => { emit("second", "running"); setState("New invocation"); }}>Start another tool</button>
    </nav>
    <output aria-live="polite">{state}</output>
    <section className="gyro-chat-surface is-thread" style={{ height: "auto", overflow: "visible" }}>
      <div className="gyro-chat-turn"><div className="gyro-chat-run">
        {events.length > 0 && <ChatRun model={model} suppressThinkingIndicator />}
      </div></div>
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
