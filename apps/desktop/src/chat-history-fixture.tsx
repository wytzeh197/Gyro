// Standalone production ChatSurface with labeled generated history; no native IPC.
import React, { Profiler, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import {
  limitSessionEventsForUi,
  mergePersistedAndOptimisticEvents,
} from "./provider-stream-events";
import { mergeSessionHistoryPages } from "./session-event-order";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: true,
  requireFileEditApproval: true,
  telemetryEnabled: false,
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((p) =>
    p.id === "openai" ? { ...p, enabled: true, authStatus: "connected" } : p,
  ),
};
function event(index: number): SessionEvent {
  return {
    id: "history-" + index,
    sessionId: "complete-history-fixture",
    turnId: "turn-" + Math.floor(index / 2),
    createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    kind: index % 2 === 0 ? "user-message" : "assistant-message",
    message:
      index === 0
        ? "First message in the entire saved chat."
        : index % 2 === 0
          ? "History question " + Math.floor(index / 2)
          : "History answer " +
            Math.floor(index / 2) +
            ". This earlier reply stays available as the conversation grows.",
    payload:
      index % 2 === 0 ? {} : { kind: "provider-response", status: "done" },
  };
}
const saved = Array.from({ length: 3100 }, (_, i) => event(i));
function Fixture() {
  const [events, setEvents] = useState(saved);
  const streamCosts = useRef<number[]>([]);
  const streamActive = useRef(false);
  const [streamCost, setStreamCost] = useState(0);
  const stream = () => {
    if (streamActive.current) return;
    streamActive.current = true;
    streamCosts.current = [];
    let tick = 0;
    const next = () => {
      if (tick++ === 20) {
        streamActive.current = false;
        setStreamCost(
          streamCosts.current.reduce((a, b) => a + b, 0) /
            Math.max(1, streamCosts.current.length),
        );
        setStatus("Stream fixture completed.");
        return;
      }
      setEvents((current) =>
        current.map((row, index) =>
          index === current.length - 1
            ? { ...row, message: row.message + " streamed" }
            : row,
        ),
      );
      window.setTimeout(next, 80);
    };
    next();
  };
  const [mount, setMount] = useState(0);
  const [status, setStatus] = useState("Complete saved history loaded.");
  const append = () => {
    setEvents((current) =>
      limitSessionEventsForUi(
        mergePersistedAndOptimisticEvents(
          mergeSessionHistoryPages(current, current.slice(-400)),
          Array.from({ length: 1000 }, (_, i) => event(current.length + i)),
        ),
      ),
    );
    setStatus(
      "Appended 500 turns through production transcript reconciliation.",
    );
  };
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-bg)",
        color: "var(--gyro-text)",
      }}
    >
      <header
        style={{
          padding: 16,
          borderBottom: "1px solid var(--gyro-border)",
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>Complete chat history fixture</strong>
        <span>
          Actual chat component · 1,550 generated saved turns · simulated
          disk/provider
        </span>
        <button onClick={append}>Append 500 turns</button>
        <button onClick={stream}>Stream latest reply</button>
        <output id="stream-render-cost" data-ms={streamCost}>
          {streamCost.toFixed(2)} ms per stream render
        </output>
        <button
          onClick={() => {
            setMount((n) => n + 1);
            setStatus(
              "Reopened complete conversation; reading position restored.",
            );
          }}
        >
          Reopen saved chat
        </button>
        <output id="event-count">{events.length} events retained</output>
      </header>
      <p role="status" style={{ margin: 0, padding: "8px 16px" }}>
        {status}
      </p>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Profiler
          id="history"
          onRender={(_id, phase, duration) => {
            if (streamActive.current && phase !== "mount")
              streamCosts.current.push(duration);
          }}
        >
          <ChatSurface
            key={mount}
            config={config}
            events={events}
            paneKey="history-fixture"
            sessionTitle="Complete saved conversation"
            workspacePath="/fixture/Gyro"
            shellReady
            isEnvironmentRailOpen={false}
            onComposerAction={() => {}}
            onSend={() => {}}
          />
        </Profiler>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
