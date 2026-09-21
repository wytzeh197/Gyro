// Development-only preview of the real workspace sidebar chat.
import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const empty: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((p) =>
    p.id === "openai" ? { ...p, enabled: true, authStatus: "connected" } : p,
  ),
};
const events: SessionEvent[] = [
  {
    id: "request",
    sessionId: "preview",
    turnId: "turn",
    kind: "user-message",
    payload: {},
    createdAt: "2026-09-21T10:00:00Z",
    message: "Make the provider connection path clearer.",
  },
  {
    id: "answer",
    sessionId: "preview",
    turnId: "turn",
    kind: "assistant-message",
    createdAt: "2026-09-21T10:00:02Z",
    message:
      "Implemented a clearer provider connection path:\n\n- Choose an **existing account, API key, or local models**.\n- Connection progress is visible; duplicate sign-in attempts are blocked.\n- **Use in chat** selects the model and returns to the conversation.\n\nType checks and setup/workbench checks passed. Preview interactions passed with simulated sign-in; real account authentication remains unverified.",
    payload: { kind: "provider-response", status: "done" },
  },
];
function Preview() {
  const [width, setWidth] = useState(480);
  const [environment, setEnvironment] = useState(true);
  const [dark, setDark] = useState(false);
  const [measurement, setMeasurement] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const measure = () => {
      const element = root.current;
      const transcript = element?.querySelector(".gyro-chat-transcript");
      const composer = element?.querySelector(".gyro-composer-shell");
      setMeasurement(
        `Sidebar ${width}px · transcript ${Math.round(transcript?.getBoundingClientRect().width ?? 0)}px · composer ${Math.round(composer?.getBoundingClientRect().width ?? 0)}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    root.current
      ?.querySelectorAll(".gyro-chat-transcript,.gyro-composer-shell")
      .forEach((el) => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, [width, environment, dark]);
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-sidebar)",
        color: "var(--gyro-text)",
      }}
    >
      <nav style={{ display: "flex", gap: 12, padding: 12, flexWrap: "wrap" }}>
        {[440, 480, 620].map((w) => (
          <button key={w} onClick={() => setWidth(w)}>
            {w}px
          </button>
        ))}
        <button onClick={() => setDark(!dark)}>Toggle theme</button>
        <output>{measurement}</output>
      </nav>
      <div className="gyro-app-shell is-workspace-shell" style={{ display: "flex", width, maxWidth: "100%", flex: 1, minHeight: 0, minWidth: 0, minBlockSize: 0 }}>
      <aside className="gyro-sidebar" style={{width: "100%", minHeight: 0}}>
      <div
        ref={root}
        className="gyro-sidebar-ai-chat"
        style={{
          width: "100%",
          maxWidth: "100%",
          flex: 1,
        }}
      >
        <ChatSurface
          config={config}
          events={events}
          sessionTitle="Settings Design Polish"
          workspacePath="/Users/dev/Gyro"
          branchName="release/v0.1.0-alpha.49"
          draft="Polish the workspace sidebar chat and keep the composer easy to use."
          sessionModel={{
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            modelLabel: "GPT-5.6 Sol",
          }}
          isEnvironmentRailOpen={environment}
          onToggleEnvironmentRail={() => setEnvironment(!environment)}
          onComposerAction={() => {}}
          onSend={() => {}}
        />
      </div>
      </aside>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
