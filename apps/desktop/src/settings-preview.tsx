// Development-only preview of real settings components with in-memory preferences.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SettingsSurface,
  type ThemeMode,
  providersForConfig,
  type GyroConfig,
  type ProviderId,
  type SettingsSectionId,
  type UpdateState,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

/** Representative updater states, so the Updates section can be reviewed whole.
    "unavailable" carries no state at all, which is the shape the surface gets
    when the updater cannot report anything. */
const UPDATE_SCENES: Array<{
  id: string;
  label: string;
  state?: UpdateState;
}> = [
  {
    id: "current",
    label: "Up to date",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      status: "current",
    },
  },
  {
    id: "checking",
    label: "Checking",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      status: "checking",
    },
  },
  {
    id: "available",
    label: "Update available",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      nextVersion: "0.1.0-alpha.50",
      releaseNotes:
        "Updates settings now lead with a status card that names the installed build, the channel, and the next step.\n\nSigned Alpha archives are still verified with Gyro's updater key before install.",
      status: "available",
      totalBytes: 41_943_040,
    },
  },
  {
    id: "downloading",
    label: "Downloading",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      downloadedBytes: 26_843_545,
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      nextVersion: "0.1.0-alpha.50",
      progressPercent: 64,
      status: "downloading",
      totalBytes: 41_943_040,
    },
  },
  {
    id: "ready",
    label: "Ready to install",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      nextVersion: "0.1.0-alpha.50",
      status: "ready",
      totalBytes: 41_943_040,
    },
  },
  {
    id: "installing",
    label: "Installing",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      nextVersion: "0.1.0-alpha.50",
      status: "installing",
      totalBytes: 41_943_040,
    },
  },
  {
    id: "failed",
    label: "Failed",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      error: "The update download was interrupted before it finished.",
      lastCheckedAt: "2026-09-22T13:28:00.000Z",
      nextVersion: "0.1.0-alpha.50",
      silentFailure: false,
      status: "failed",
    },
  },
  {
    id: "development",
    label: "Development",
    state: {
      currentVersion: "0.1.0-alpha.49.3",
      status: "development",
    },
  },
  {
    id: "unavailable",
    label: "No updater",
  },
];

function Preview() {
  const [theme, setTheme] = useState<ThemeMode>(() =>
    new URLSearchParams(location.search).get("theme") === "dark"
      ? "dark"
      : "light",
  );
  const [scene] = useState(() =>
    new URLSearchParams(location.search).get("scene"),
  );
  const [section, setSection] = useState<SettingsSectionId>(
    scene === "providers"
      ? "providers"
      : scene === "updates"
        ? "updates"
        : "appearance",
  );
  const [updateScene, setUpdateScene] = useState(
    () => new URLSearchParams(location.search).get("state") ?? "available",
  );
  const [density, setDensity] = useState<"compact" | "comfortable">("compact");
  const [quick, setQuick] = useState(true);
  const [menu, setMenu] = useState(true);
  const [follow, setFollow] = useState<"off" | "peek" | "follow">("peek");
  const [config, setConfig] = useState<GyroConfig>(() => {
    const empty = {
      telemetryEnabled: false,
      requireCommandApproval: true,
      requireFileEditApproval: true,
      modelProviders: [],
      commandProfiles: [],
    };
    return {
      ...empty,
      modelProviders: providersForConfig(empty).map((provider) => ({
        ...provider,
        enabled: false,
        authStatus: "not-connected",
      })),
    };
  });
  const [connecting, setConnecting] = useState<ProviderId[]>([]);
  const [result, setResult] = useState("");
  const [colors, setColors] = useState(() => {
    const params = new URLSearchParams(location.search);
    return [
      params.get("accent") ?? "#0874df",
      params.get("secondary") ?? "#8b6fcb",
    ];
  });
  const updateState = UPDATE_SCENES.find(
    (entry) => entry.id === updateScene,
  )?.state;
  document.documentElement.dataset.theme = theme === "system" ? "light" : theme;
  document.documentElement.dataset.density = density;
  // The running app applies the chosen accent at the root, so the preview has
  // to as well — otherwise it cannot show which surfaces follow
  // Appearance → Colors and which carry a colour of their own.
  document.documentElement.style.setProperty("--gyro-user-main", colors[0]!);
  document.documentElement.style.setProperty(
    "--gyro-user-secondary",
    colors[1]!,
  );
  return (
    <div
      style={{
        height: "100vh",
        overflow: "auto",
        background: "var(--gyro-pane)",
        color: "var(--gyro-text)",
      }}
    >
      <nav
        aria-label="Preview sections"
        style={{ display: "flex", gap: 16, padding: 16 }}
      >
        {(
          ["general", "appearance", "advanced", "providers", "updates"] as const
        ).map((id) => (
          <button key={id} onClick={() => setSection(id)}>
            {id}
          </button>
        ))}
      </nav>
      {section === "updates" ? (
        <nav
          aria-label="Update states"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            padding: "0 16px 8px",
          }}
        >
          {UPDATE_SCENES.map((entry) => (
            <button key={entry.id} onClick={() => setUpdateScene(entry.id)}>
              {entry.label}
            </button>
          ))}
        </nav>
      ) : null}
      <p role="status">{result}</p>
      {connecting.length > 0 ? (
        <button
          onClick={() => {
            setConfig((current) => ({
              ...current,
              modelProviders: current.modelProviders.map((provider) =>
                connecting.includes(provider.id)
                  ? { ...provider, enabled: true, authStatus: "connected" }
                  : provider,
              ),
            }));
            setConnecting([]);
          }}
        >
          Complete simulated sign-in
        </button>
      ) : null}
      <SettingsSurface
        config={config}
        connectingProviderIds={connecting}
        onToggleProvider={(id) => setConnecting([id as ProviderId])}
        onSelectProviderDefaultModel={(id, modelId) =>
          setConfig((current) => ({
            ...current,
            modelProviders: current.modelProviders.map((provider) =>
              provider.id === id
                ? { ...provider, defaultModelId: modelId }
                : provider,
            ),
          }))
        }
        onUseProvider={(id, modelId) =>
          setResult(`Selected ${id}: ${modelId} for chat`)
        }
        activeSection={section}
        themeMode={theme}
        onThemeChange={setTheme}
        density={density}
        onDensityChange={setDensity}
        showQuickActions={quick}
        onQuickActionsVisibilityChange={setQuick}
        showMenuBarIcon={menu}
        onMenuBarVisibilityChange={setMenu}
        modelFollow={follow}
        onModelFollowChange={setFollow}
        mainColor={colors[0]}
        secondaryColor={colors[1]}
        updateState={updateState}
        onCheckForUpdates={() => setResult("Checked for updates (preview)")}
        onUpdateAction={(state) => setResult(`Update action: ${state.status}`)}
        onAppearanceColorsChange={(main, secondary) =>
          setColors([main, secondary])
        }
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
