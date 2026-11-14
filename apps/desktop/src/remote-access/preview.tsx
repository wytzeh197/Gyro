import React from "react";
import { createRoot } from "react-dom/client";
import { AppChrome, SettingsSurface, type GyroConfig } from "@gyro-dev/ui";
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
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteWorkspaceRoot ports={fixture.port}>
      <AppChrome
        sessions={[]}
        commandProfiles={[]}
        savedProjects={[]}
        activeDestination="settings"
        activeWorkspaceLayout="thread"
        activeSettingsSection="remote-access"
        onSelectSession={() => {}}
        onCreateSession={() => {}}
        onCreateCliSession={() => {}}
        onSelectSessions={() => {}}
        onSelectWorkspaceLayout={() => {}}
        onSelectDestination={() => {}}
        onOpenToolPanel={() => {}}
        onOpenSettings={() => {}}
        onOpenCommandPalette={() => {}}
        onOpenWorkspace={() => {}}
      >
        <SettingsSurface
          config={config}
          themeMode="dark"
          activeSection="remote-access"
          onThemeChange={() => {}}
        />
      </AppChrome>
    </RemoteWorkspaceRoot>
  </React.StrictMode>,
);
