import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeModeActivityCard, groupWorkflowEvents } from "@gyro-dev/ui";
import type { SessionEvent } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

function fixture(status: string): SessionEvent {
  const id = "workflow-" + status;
  const completed = ["completed", "partial", "cancelled", "inactive"].includes(
    status,
  );
  const childStatuses =
    status === "partial"
      ? ["completed", "denied"]
      : status === "waiting"
        ? ["completed", "waiting"]
        : completed
          ? ["completed", "completed"]
          : ["completed", "running"];
  const base = {
    sessionId: "fixture-chat",
    turnId: id,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "system-event" as const,
  };
  const parent: SessionEvent = {
    ...base,
    id,
    payload: {
      schema: "gyro.capability.v1",
      kind: "capability-call",
      capabilityId: "code-mode-execute",
      callId: id,
      status: status === "partial" ? "completed" : status,
      summary: "Inspect settings screens",
      codeMode: {
        label: "Checking settings screens",
        source:
          "const found = await tools.gyro_workspace_search({query:'gap:', globs:['src/settings/**']});\nreturn found.data;",
        ...(completed
          ? {
              outcome: {
                completed: status === "partial" ? 1 : 2,
                partial: status === "partial",
                outcome:
                  status === "partial"
                    ? {
                        ok: false,
                        error: {
                          kind: "ToolFailure",
                          message:
                            "Permission to read private-settings.json was denied.",
                        },
                      }
                    : {
                        ok: true,
                        value: { checked: 8, usingTokens: 6, hardCodedGaps: 2 },
                      },
              },
            }
          : {}),
      },
    },
    message: "Inspect settings screens",
  };
  const children: SessionEvent[] = childStatuses.map((state, index) => ({
    ...base,
    id: id + "-" + index,
    message: "Workspace inspection",
    payload: {
      schema: "gyro.capability.v1",
      kind: "capability-call",
      capabilityId: index ? "workspace-read" : "workspace-search",
      callId: id + "-" + index,
      groupId: id,
      status: state,
      summary: index ? "Read settings/layout.tsx" : "Found 8 settings screens",
      resource: {
        id: "fixture-file",
        kind: "ide",
        label: index ? "settings/layout.tsx" : "src/settings",
      },
    },
  }));
  return groupWorkflowEvents([parent, ...children])[0]!;
}
function Preview() {
  const [width, setWidth] = useState("full"),
    [theme, setTheme] = useState("dark"),
    [notice, setNotice] = useState(""),
    [replayed, setReplayed] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    const colors =
      theme === "dark"
        ? ["#101112", "#191b1d", "#e9eaec", "#9da3ac", "#30343a"]
        : ["#f6f6f5", "#ffffff", "#202328", "#616772", "#dce0e5"];
    [
      "--gyro-app",
      "--gyro-panel",
      "--gyro-text",
      "--gyro-muted",
      "--gyro-border",
    ].forEach((name, index) => root.style.setProperty(name, colors[index]!));
  }, [theme]);
  return (
    <main
      data-theme={theme}
      style={
        {
          "--gyro-app": theme === "dark" ? "#101112" : "#f6f6f5",
          "--gyro-panel": theme === "dark" ? "#191b1d" : "#fff",
          "--gyro-text": theme === "dark" ? "#e9eaec" : "#202328",
          "--gyro-muted": theme === "dark" ? "#9da3ac" : "#616772",
          "--gyro-border": theme === "dark" ? "#30343a" : "#dce0e5",
        } as React.CSSProperties
      }
    >
      <style>{`body{margin:0;font-family:system-ui}main{background:var(--gyro-app);color:var(--gyro-text);min-height:100vh;padding:32px;box-sizing:border-box}header{max-width:720px;margin:auto auto 28px}h1{font-size:24px;letter-spacing:-.6px;margin:0 0 10px}header p{color:var(--gyro-muted);line-height:1.5;font-size:13px}nav{display:flex;gap:8px;flex-wrap:wrap}nav button{padding:7px 10px;background:var(--gyro-panel);color:var(--gyro-text);border:1px solid var(--gyro-border);border-radius:7px;cursor:pointer}section{margin:24px 0}section>h2{font-size:11px;color:var(--gyro-muted);text-transform:uppercase;letter-spacing:1px;font-weight:550}.fixture-approval{padding:12px;border:1px solid var(--gyro-border);border-radius:8px;font-size:12px;margin-top:8px}.fixture-approval button{margin-top:10px;margin-right:8px}button:focus-visible{outline:2px solid #b9a0ed;outline-offset:3px}`}</style>
      <header>
        <h1>Code Mode activity</h1>
        <p>
          Standalone preview of the production component. All actions, counts,
          files, and approvals below are labeled fixtures.
        </p>
        <nav>
          <button onClick={() => setWidth(width === "full" ? "375" : "full")}>
            {width === "full" ? "Narrow pane" : "Full width"}
          </button>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <button onClick={() => setReplayed(!replayed)}>
            {replayed ? "Reset workflow" : "Complete running fixture"}
          </button>
        </nav>
        <p role="status">{notice}</p>
      </header>
      <div style={{ maxWidth: width === "375" ? 375 : 720, margin: "auto" }}>
        {[
          "running",
          "waiting",
          "completed",
          "partial",
          "cancelled",
          "inactive",
        ].map((state) => (
          <section key={state} data-fixture={state}>
            <h2>{state} fixture</h2>
            <CodeModeActivityCard
              event={fixture(
                state === "running" && replayed ? "completed" : state,
              )}
              onAction={(_, event) =>
                setNotice(
                  "Opened " +
                    String(
                      (event.payload as { resource: { label: string } })
                        .resource.label,
                    ) +
                    " · fixture only",
                )
              }
            />
            {state === "waiting" ? (
              <div className="fixture-approval">
                <strong>Approval fixture · Read private-settings.json</strong>
                <p>This decision stays outside the collapsed workflow.</p>
                <button
                  style={{
                    color: "#202328",
                    background: "#e7e9ed",
                    border: "1px solid #b8bdc6",
                  }}
                  onClick={() =>
                    setNotice("Allow once selected · fixture only")
                  }
                >
                  Allow once
                </button>
                <button
                  style={{
                    color: "#202328",
                    background: "#e7e9ed",
                    border: "1px solid #b8bdc6",
                  }}
                  onClick={() => setNotice("Denied · fixture only")}
                >
                  Deny
                </button>
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
