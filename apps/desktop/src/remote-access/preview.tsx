import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  SettingsSurface,
  type GyroConfig,
  type Session,
} from "@gyro-dev/ui";
import { RemoteWorkspaceRoot } from "./root";
import { createPreviewPorts } from "./preview-ports";
import "@gyro-dev/ui/styles.css";
import "../theme.css";
const fixture = createPreviewPorts();
Object.assign(window, { gyroRemoteFixture: fixture });
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark";
const config: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
};
// Deliberately reuse the remote ID and path: ownership must stay host-scoped.
const localSession: Session = {
  id: "existing-chat",
  title: "Existing local chat",
  workspacePath: "/fixture/remote-project",
  origin: "desktop",
  createdAt: "2026-11-13T10:00:00Z",
  updatedAt: "2026-11-13T10:00:00Z",
  eventsPath: "fixture://local-events",
};
function LocalApp() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    Object.assign(window, { gyroHydrateLocalFixture: () => setLoaded(true) });
  }, []);

  const [destination, setDestination] = useState<"workspace" | "settings">(
    "settings",
  );
  const [draft, setDraft] = useState("");
  return (
    <AppChrome
      sidebarProjectsReady={loaded}
      sessions={loaded ? [localSession] : []}
      commandProfiles={[]}
      savedProjects={[]}
      workspacePath={loaded ? localSession.workspacePath : undefined}
      activeSessionId={
        destination === "workspace" ? localSession.id : undefined
      }
      activeDestination={destination}
      activeWorkspaceLayout="thread"
      activeSettingsSection="remote-access"
      onSelectSession={() => setDestination("workspace")}
      onCreateSession={() => setDestination("workspace")}
      onCreateCliSession={() => {}}
      onSelectSessions={() => setDestination("workspace")}
      onSelectWorkspaceLayout={() => setDestination("workspace")}
      onSelectDestination={() => setDestination("settings")}
      onOpenToolPanel={() => {}}
      onOpenSettings={() => setDestination("settings")}
      onOpenCommandPalette={() => {}}
      onOpenWorkspace={() => {}}
    >
      {destination === "settings" ? (
        <SettingsSurface
          config={config}
          themeMode="dark"
          activeSection="remote-access"
          onThemeChange={() => {}}
        />
      ) : (
        <div className="gyro-remote-home">
          <h1>Existing local history</h1>
          <p>This chat stays on this Mac.</p>
          <textarea
            aria-label="Local draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      )}
    </AppChrome>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteWorkspaceRoot ports={fixture.port}>
      <LocalApp />
    </RemoteWorkspaceRoot>
  </React.StrictMode>,
);
