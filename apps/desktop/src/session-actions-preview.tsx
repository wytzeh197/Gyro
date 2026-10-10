// Standalone fixture of production sidebar rows; no native IPC.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { AppChrome, type Session } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const sessions: Session[] = [
  { id: "active", title: "Traffic Light Button Placement", workspacePath: "/fixture/Gyro", origin: "desktop", createdAt: "2026-10-10T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z", eventsPath: "/fixture/active.jsonl" },
  { id: "hover", title: "Hover this long chat title to check the right edge", workspacePath: "/fixture/Gyro", origin: "desktop", createdAt: "2026-10-10T09:00:00Z", updatedAt: "2026-10-10T09:00:00Z", eventsPath: "/fixture/hover.jsonl" },
];
function Preview() {
  const [active, setActive] = useState("active");
  const [pinned, setPinned] = useState<string[]>([]);
  const [theme, setTheme] = useState("dark");
  const [large, setLarge] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--gyro-ui-scale", large ? "1.15" : "1");
  }, [theme, large]);
  return <AppChrome
    activeDestination="workspace" activeSessionId={active}
    activeWorkspaceLayout="thread" commandProfiles={[]} savedProjects={[]}
    sessions={sessions} pinnedSessionIds={pinned} workspacePath="/fixture/Gyro"
    onCreateCliSession={() => undefined} onCreateSession={() => undefined}
    onOpenCommandPalette={() => undefined} onOpenSettings={() => undefined}
    onOpenToolPanel={() => undefined} onOpenWorkspace={() => undefined}
    onSelectDestination={() => undefined} onSelectSession={setActive}
    onSelectSessions={() => undefined} onSelectWorkspaceLayout={() => undefined}
    onPinSession={(id) => setPinned((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])}>
    <main style={{ padding: 32, color: "var(--gyro-text)" }}>
      {createPortal(<div aria-label="Traffic lights: screenshot reference fixture" style={{ position: "fixed", left: 16, top: 18, display: "flex", gap: 9, pointerEvents: "none", zIndex: 10000 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((color) => <span key={color} style={{ width: 14, height: 14, borderRadius: "50%", background: color }} />)}
      </div>, document.body)}
      <h1>Session actions fixture</h1>
      <p>Title bar fixture: colored circles mark the traffic-light positions in your screenshot.</p>
      <p>Production sidebar with sample chats. Hover a row, pin it, or open its three-dot menu.</p>
      <p>The action group should meet the row’s right edge without a lighter strip.</p>
      <div style={{display: "flex", gap: 12}}>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
        <button onClick={() => setLarge(!large)}>Toggle interface size</button>
        <button onClick={() => document.querySelectorAll<HTMLElement>(".gyro-session-row").forEach((row) => { row.classList.add("is-menu-open"); row.style.background = "var(--gyro-shell-row-hover)"; })}>Show row actions (fixture)</button>
      </div>
    </main>
  </AppChrome>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
