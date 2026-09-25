// Development-only preview of the post-restart notice in the real sidebar.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppChrome, type Session, type UpdateState } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "@gyro-dev/ui/installed-update.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  query.get("theme") === "light" ? "light" : "dark";

const sessions: Session[] = [
  {
    id: "session-1",
    title: "Plan the next Gyro release",
    workspacePath: "/Users/dev/Gyro",
    origin: "desktop",
    createdAt: "2026-09-25T08:00:00Z",
    updatedAt: "2026-09-25T09:00:00Z",
    eventsPath: "/tmp/session-1.jsonl",
  },
  {
    id: "session-2",
    title: "Improve provider setup",
    workspacePath: "/Users/dev/Gyro",
    origin: "desktop",
    createdAt: "2026-09-24T08:00:00Z",
    updatedAt: "2026-09-24T09:00:00Z",
    eventsPath: "/tmp/session-2.jsonl",
  },
  {
    id: "session-3",
    title: "Review launch checklist",
    workspacePath: "/Users/dev/Gyro",
    origin: "desktop",
    createdAt: "2026-09-23T08:00:00Z",
    updatedAt: "2026-09-23T09:00:00Z",
    eventsPath: "/tmp/session-3.jsonl",
  },
];

const updateState: UpdateState = query.has("pendingUpdate")
  ? {
      status: "available",
      currentVersion: "0.1.0-alpha.50",
      nextVersion: "0.1.0-alpha.51",
    }
  : {
      status: "current",
      currentVersion: "0.1.0-alpha.50",
    };

function Preview() {
  const [visible, setVisible] = useState(true);
  const installedState: UpdateState = visible
    ? {
        ...updateState,
        installedUpdateNotice: {
          version: "0.1.0-alpha.50",
          releaseNotes: query.has("emptyNotes")
            ? ""
            : "A clearer provider connection flow makes it easier to get started with an existing account, API key, or local model.\n\nThe chat sidebar now keeps your composer and active conversation in view. We also refined update status and fixed several small reliability issues.",
        },
        dismissInstalledUpdateNotice: () => setVisible(false),
      }
    : updateState;
  return (
    <AppChrome
      activeDestination="workspace"
      activeSessionId="session-1"
      activeWorkspaceLayout="thread"
      commandProfiles={[]}
      onCreateCliSession={() => undefined}
      onCreateSession={() => undefined}
      onOpenCommandPalette={() => undefined}
      onOpenSettings={() => undefined}
      onOpenToolPanel={() => undefined}
      onOpenWorkspace={() => undefined}
      onSelectDestination={() => undefined}
      onSelectSession={() => undefined}
      onSelectSessions={() => undefined}
      onSelectWorkspaceLayout={() => undefined}
      savedProjects={[]}
      sessions={sessions}
      updateState={installedState}
      workspacePath="/Users/dev/Gyro"
    >
      <div
        style={{
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
          height: "100vh",
          padding: "26px 42px 24px",
        }}
      >
        <div
          style={{
            borderBottom: "1px solid var(--gyro-border-soft)",
            padding: "16px 0",
          }}
        >
          <strong>Plan the next Gyro release</strong>
        </div>
        <div
          style={{
            alignContent: "center",
            color: "var(--gyro-muted)",
            maxWidth: 650,
          }}
        >
          <p
            style={{ color: "var(--gyro-text)", fontSize: 19, fontWeight: 600 }}
          >
            Plan the next Gyro release
          </p>
          <p>
            We’ve finished the release checklist and updated the provider setup
            flow.
          </p>
          <p>
            The new build is installed. Your recent chats are ready to continue.
          </p>
        </div>
        <div
          style={{
            background: "var(--gyro-surface)",
            border: "1px solid var(--gyro-border)",
            borderRadius: 16,
            color: "var(--gyro-faint)",
            maxWidth: 740,
            padding: "18px 20px",
          }}
        >
          Ask Gyro anything…
        </div>
      </div>
    </AppChrome>
  );
}

const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Preview />);
