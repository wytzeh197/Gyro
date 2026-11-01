// Development-only preview of the real workspace sidebar chat.
import React, { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  ProjectImportCallout,
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
  const [height, setHeight] = useState(640);
  const [thread, setThread] = useState(false);
  const [environment, setEnvironment] = useState(false);
  const [dark, setDark] = useState(true);
  const [scale, setScale] = useState(1);
  const [showImport, setShowImport] = useState(true);
  const [draft, setDraft] = useState("");
  const [action, setAction] = useState("Ready");
  const [measurement, setMeasurement] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty(
      "--gyro-ui-scale",
      String(scale),
    );
    const measure = () => {
      const element = root.current;
      if (!element) return;
      const rect = (selector: string) =>
        element.querySelector(selector)?.getBoundingClientRect();
      const composer = element.querySelector(".gyro-composer-shell");
      const toolbar = element.querySelector(".gyro-composer-bar");
      const bounds = element.getBoundingClientRect();
      const callout = rect(".gyro-project-import-callout");
      const copy = rect(".gyro-import-callout-copy");
      const logo = rect(".gyro-chat-start > .gyro-brand-logo");
      const composerBounds = composer?.getBoundingClientRect();
      const overflow = [composer, toolbar].some(
        (el) => el && el.scrollWidth > el.clientWidth + 1,
      );
      setMeasurement(
        `Sidebar ${Math.round(bounds.width)}px · composer ${Math.round(composerBounds?.width ?? 0)}px · import ${Math.round(callout?.width ?? 0)}px · copy ${Math.round(copy?.width ?? 0)}px · logo Y ${Math.round((logo?.top ?? bounds.top) - bounds.top)}px · overflow ${overflow ? "yes" : "none"}`,
      );
    };
    const observer = new ResizeObserver(measure);
    if (root.current) {
      observer.observe(root.current);
      root.current
        .querySelectorAll(
          ".gyro-composer-shell,.gyro-composer-bar,.gyro-project-import-callout,.gyro-import-callout-copy",
        )
        .forEach((el) => observer.observe(el));
    }
    measure();
    return () => observer.disconnect();
  }, [width, height, thread, environment, dark, scale, showImport]);
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--gyro-sidebar)",
        color: "var(--gyro-text)",
      }}
    >
      <style>{`
        /* Keep fixture captures stable while the preview is backgrounded. */
        main *, main *::before, main *::after { transition: none !important; animation: none !important; }
        nav[aria-label="Preview controls"] button { color: var(--gyro-text); }
      `}</style>
      <nav
        aria-label="Preview controls"
        style={{
          display: "flex",
          gap: 8,
          padding: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <strong>IDE side chat · simulated data</strong>
        {[440, 480, 520, 620].map((w) => (
          <button
            key={w}
            aria-pressed={width === w}
            onClick={() => setWidth(w)}
          >
            {w}px
          </button>
        ))}
        <button onClick={() => setThread(!thread)}>
          {thread ? "Show empty chat" : "Show conversation"}
        </button>
        <button onClick={() => setDark(!dark)}>Toggle theme</button>
        <button onClick={() => setScale(scale === 1 ? 1.25 : 1)}>
          UI scale {scale === 1 ? "100%" : "125%"}
        </button>
        <button onClick={() => setHeight(height === 640 ? 920 : 640)}>
          {height === 640 ? "Tall panel" : "Short panel"}
        </button>
        <button onClick={() => setShowImport(true)}>Restore import card</button>
      </nav>
      <output
        aria-label="Layout measurements"
        style={{ display: "block", padding: "0 12px 8px", fontSize: 12 }}
      >
        {measurement}
      </output>
      <output
        aria-label="Fixture action"
        style={{ display: "block", padding: "0 12px 8px", fontSize: 12 }}
      >
        {action}
      </output>
      <div
        className="gyro-app-shell is-workspace-shell"
        style={{
          display: "flex",
          width,
          maxWidth: "100%",
          height,
          minHeight: 0,
          minWidth: 0,
          minBlockSize: 0,
        }}
      >
        <aside className="gyro-sidebar" style={{ width: "100%", minHeight: 0 }}>
          <div
            ref={root}
            className="gyro-sidebar-ai-chat gyro-ide-assistant-chat"
            style={{ width: "100%", maxWidth: "100%", flex: 1 }}
          >
            <ChatSurface
              config={config}
              events={thread ? events : []}
              sessionTitle={thread ? "Settings Design Polish" : undefined}
              workspacePath="/Users/dev/Gyro"
              branchName="v0.1.0"
              draft={draft}
              onDraftChange={setDraft}
              sessionModel={{
                providerId: "openai",
                modelId: "gpt-6.1-sol",
                modelLabel: "GPT-6.1 Sol",
              }}
              welcomeCallout={
                showImport ? (
                  <ProjectImportCallout
                    onOpen={() => setAction("Import projects opened (fixture)")}
                    onDismiss={() => {
                      setShowImport(false);
                      setAction("Import suggestion dismissed (fixture)");
                    }}
                  />
                ) : undefined
              }
              chatSwitcher={{
                chats: [{ id: "preview", title: "Settings Design Polish" }],
                activeChatId: thread ? "preview" : undefined,
                onSelect: () => {
                  setThread(true);
                  setAction("Recent conversation selected (fixture)");
                },
                onNewChat: () => {
                  setThread(false);
                  setDraft("");
                  setAction("New chat selected (fixture)");
                },
              }}
              isEnvironmentRailOpen={environment}
              onToggleEnvironmentRail={() => setEnvironment(!environment)}
              onComposerAction={(next) =>
                setAction(`Composer action: ${next} (fixture)`)
              }
              onSend={() =>
                setAction("Message submitted (fixture; no provider request)")
              }
            />
          </div>
        </aside>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
