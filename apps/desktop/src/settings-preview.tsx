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
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
function Preview() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [section, setSection] = useState<SettingsSectionId>(
    new URLSearchParams(location.search).get("scene") === "providers"
      ? "providers"
      : "appearance",
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
  const [colors, setColors] = useState(["#0874df", "#8b6fcb"]);
  document.documentElement.dataset.theme = theme === "system" ? "light" : theme;
  document.documentElement.dataset.density = density;
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
        {(["general", "appearance", "advanced", "providers"] as const).map(
          (id) => (
            <button key={id} onClick={() => setSection(id)}>
              {id}
            </button>
          ),
        )}
      </nav>
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
        onAppearanceColorsChange={(main, secondary) =>
          setColors([main, secondary])
        }
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
