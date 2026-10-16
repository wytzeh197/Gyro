// Standalone production components. Preferences persist in fixture-only storage;
// accounts, updater state, and workspace data are simulated.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  SettingsSurface,
  applyAppearancePreferences,
  type WorkbenchPreferences,
  type InterfaceSize,
  type MotionSpeed,
  type ThemeMode,
  providersForConfig,
  isCustomProviderId,
  type DesktopNotificationPreferences,
  type GyroConfig,
  type ProviderId,
  type SettingsSectionId,
  type UpdateState,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { projectImportPreview } from "./project-import-preview";
import { readBoundedLocalStorage, safeSetLocalStorage } from "./ui-storage";
import { useAppearanceSaveFeedback } from "./use-appearance-save-feedback";

const params = new URLSearchParams(location.search);
const appearanceStorageKey = `gyro.settings-preview.appearance.${params.get("theme") ?? "light"}`;
type PreviewAppearance = Pick<
  WorkbenchPreferences,
  | "theme"
  | "density"
  | "interfaceSize"
  | "motionSpeed"
  | "mainColor"
  | "secondaryColor"
>;
function loadPreviewAppearance(): PreviewAppearance {
  const initial: PreviewAppearance = {
    theme: params.get("theme") === "dark" ? "dark" : "light",
    density: "comfortable",
    interfaceSize: "default",
    motionSpeed: "default",
    mainColor: params.get("accent") ?? "#0874df",
    secondaryColor: params.get("secondary") ?? "#8b6fcb",
  };
  try {
    const stored = JSON.parse(
      readBoundedLocalStorage(appearanceStorageKey, 4096) ?? "{}",
    );
    if (["system", "light", "dark"].includes(stored.theme))
      initial.theme = stored.theme;
    if (["compact", "comfortable"].includes(stored.density))
      initial.density = stored.density;
    if (["small", "default", "large"].includes(stored.interfaceSize))
      initial.interfaceSize = stored.interfaceSize;
    if (["slower", "default", "faster"].includes(stored.motionSpeed))
      initial.motionSpeed = stored.motionSpeed;
    for (const key of ["mainColor", "secondaryColor"] as const) {
      if (
        typeof stored[key] === "string" &&
        /^#[0-9a-f]{6}$/i.test(stored[key])
      )
        initial[key] = stored[key];
    }
  } catch {
    /* Malformed fixture storage restores the defaults. */
  }
  return initial;
}

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
  const [initial] = useState(loadPreviewAppearance);
  const [theme, setTheme] = useState<ThemeMode>(initial.theme);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [defaultWorkspaceMode, setDefaultWorkspaceMode] = useState<
    "local" | "worktree"
  >("local");
  const [failSave, setFailSave] = useState(params.has("failSave"));
  const failSaveRef = useRef(failSave);
  failSaveRef.current = failSave;
  const [scene] = useState(() =>
    new URLSearchParams(location.search).get("scene"),
  );
  const [section, setSection] = useState<SettingsSectionId>(
    scene === "providers"
      ? "providers"
      : scene === "updates"
        ? "updates"
        : scene === "import"
          ? "import-projects"
          : "appearance",
  );
  const [updateScene, setUpdateScene] = useState(
    () => new URLSearchParams(location.search).get("state") ?? "available",
  );
  const [density, setDensity] = useState<"compact" | "comfortable">(
    initial.density,
  );
  const [interfaceSize, setInterfaceSize] = useState<InterfaceSize>(
    initial.interfaceSize,
  );
  const [motionSpeed, setMotionSpeed] = useState<MotionSpeed>(
    initial.motionSpeed,
  );
  const [reduceMotion, setReduceMotion] = useState(false);
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      setReduceMotion(motion.matches);
      setSystemDark(dark.matches);
    };
    sync();
    motion.addEventListener("change", sync);
    dark.addEventListener("change", sync);
    return () => {
      motion.removeEventListener("change", sync);
      dark.removeEventListener("change", sync);
    };
  }, []);
  const [menu, setMenu] = useState(true);
  const [notifications, setNotifications] =
    useState<DesktopNotificationPreferences>({
      enabled: true,
      approvals: true,
      finished: true,
      failed: false,
    });
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
      modelProviders: [
        ...providersForConfig(empty).map((provider) => ({
          ...provider,
          enabled: false,
          authStatus: "not-connected" as const,
        })),
        {
          id: "custom:lab" as const,
          displayName: "Lab gateway",
          apiKeyRef: "provider:custom:lab",
          enabled: true,
          authMode: "env" as const,
          authStatus: "not-connected" as const,
          baseUrl: "https://lab.example/v1",
          defaultModelId: "local-model",
          modelIds: ["local-model"],
          kind: "openai-compatible",
          models: [{ id: "local-model", displayName: "local-model" }],
        },
      ],
    };
  });
  const [connecting, setConnecting] = useState<ProviderId[]>([]);
  const [result, setResult] = useState("");
  const [colors, setColors] = useState([
    initial.mainColor,
    initial.secondaryColor,
  ]);
  const previewAppearance = useMemo(
    () => ({
      theme,
      density,
      interfaceSize,
      motionSpeed,
      mainColor: colors[0]!,
      secondaryColor: colors[1]!,
    }),
    [theme, density, interfaceSize, motionSpeed, colors],
  );
  const { appearanceSaveStatus, onAppearancePersisted, retryAppearanceSave } =
    useAppearanceSaveFeedback(previewAppearance);
  const savePreview = useCallback(() => {
    const succeeded =
      !failSaveRef.current &&
      safeSetLocalStorage(
        appearanceStorageKey,
        JSON.stringify(previewAppearance),
      );
    onAppearancePersisted(previewAppearance, succeeded);
  }, [previewAppearance, onAppearancePersisted]);
  useEffect(() => {
    const timer = window.setTimeout(savePreview, 250);
    return () => window.clearTimeout(timer);
  }, [savePreview]);
  const updateState = UPDATE_SCENES.find(
    (entry) => entry.id === updateScene,
  )?.state;
  const resolvedTheme =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolvedTheme;
  applyAppearancePreferences(
    document.documentElement,
    {
      interfaceSize,
      motionSpeed,
      mainColor: colors[0]!,
      secondaryColor: colors[1]!,
    },
    resolvedTheme,
  );
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
    <div className="gyro-settings-preview">
      <style>{`
        html, body, #root { height: 100%; margin: 0; }
        .gyro-settings-preview { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--gyro-pane); color: var(--gyro-text); }
        .gyro-settings-preview *, .gyro-settings-preview *::before, .gyro-settings-preview *::after { animation: none !important; transition: none !important; }
        .gyro-settings-preview > .gyro-app-shell { height: 100%; min-height: 0; }
        .gyro-settings-preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--gyro-border-soft); font: 12px var(--gyro-font-sans); }
        .gyro-settings-preview-toolbar > span:first-child { margin-right: auto; }
        .gyro-settings-preview-toolbar button { font: inherit; }
        .gyro-settings-preview-toolbar label { display: inline-flex; align-items: center; gap: 5px; }
      `}</style>
      <nav
        className="gyro-settings-preview-toolbar"
        aria-label="Settings fixture controls"
      >
        <span>
          Settings fixture · actual components · accounts and workspace
          simulated
        </span>
        <label>
          <input
            aria-label="Simulate save failure"
            type="checkbox"
            checked={failSave}
            onChange={(event) => setFailSave(event.target.checked)}
          />
          Simulate save failure
        </label>
        <label>
          <input
            aria-label="Simulate Reduce Motion"
            type="checkbox"
            checked={reduceMotion}
            onChange={(event) => setReduceMotion(event.target.checked)}
          />
          Reduce Motion
        </label>
        {section === "updates"
          ? UPDATE_SCENES.map((entry) => (
              <button key={entry.id} onClick={() => setUpdateScene(entry.id)}>
                {entry.label}
              </button>
            ))
          : null}
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
        {result ? <output>{result}</output> : null}
      </nav>
      <AppChrome
        sessions={[]}
        commandProfiles={config.commandProfiles}
        savedProjects={[]}
        activeDestination="settings"
        activeWorkspaceLayout="thread"
        activeSettingsSection={section}
        workspacePath="/fixture/Gyro"
        workspaceSidebarHidden={sidebarHidden}
        onWorkspaceSidebarHiddenChange={setSidebarHidden}
        onSettingsSectionChange={setSection}
        onOpenSettingsSection={setSection}
        onSelectSession={() => {}}
        onSelectWorkspaceLayout={() => {}}
        onSelectDestination={() =>
          setResult("Navigation outside Settings is simulated.")
        }
        onOpenToolPanel={() => {}}
        onOpenSettings={() => setSection("general")}
        onOpenCommandPalette={() => {}}
        onCreateSession={() => {}}
        onCreateCliSession={() => {}}
        onSelectSessions={() => {}}
        onOpenWorkspace={() => {}}
        onSettingsBack={() => setResult("Back to app is simulated.")}
        settingsBackLabel="fixture"
      >
        <SettingsSurface
          projectImport={projectImportPreview(updateScene, setResult)}
          config={config}
          workspacePath="/fixture/Gyro"
          workspaceRoots={["/fixture/Gyro"]}
          onConfigChange={setConfig}
          onSectionChange={setSection}
          defaultWorkspaceMode={defaultWorkspaceMode}
          onDefaultWorkspaceModeChange={setDefaultWorkspaceMode}
          appearanceSaveStatus={appearanceSaveStatus}
          onRetryAppearanceSave={() => {
            retryAppearanceSave();
            savePreview();
          }}
          connectingProviderIds={connecting}
          onRemoveProvider={async (id) => {
            setConfig((current) => {
              if (isCustomProviderId(id)) {
                return {
                  ...current,
                  selectedProviderId:
                    current.selectedProviderId === id
                      ? undefined
                      : current.selectedProviderId,
                  modelProviders: current.modelProviders.filter(
                    (provider) => provider.id !== id,
                  ),
                };
              }
              return {
                ...current,
                removedProviderIds: [
                  ...new Set([...(current.removedProviderIds ?? []), id]),
                ],
                selectedProviderId:
                  current.selectedProviderId === id
                    ? undefined
                    : current.selectedProviderId,
                modelProviders: current.modelProviders.map((provider) =>
                  provider.id === id
                    ? {
                        ...provider,
                        enabled: false,
                        authStatus: "not-connected",
                      }
                    : provider,
                ),
              };
            });
            setResult(`Removed ${id}`);
            return true;
          }}
          onRestoreProvider={async (id) => {
            setConfig((current) => ({
              ...current,
              removedProviderIds: (current.removedProviderIds ?? []).filter(
                (removed) => removed !== id,
              ),
            }));
            setResult(`Restored ${id}`);
            return true;
          }}
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
          interfaceSize={interfaceSize}
          onInterfaceSizeChange={setInterfaceSize}
          motionSpeed={motionSpeed}
          onMotionSpeedChange={setMotionSpeed}
          reduceMotion={reduceMotion}
          onDensityChange={setDensity}
          showMenuBarIcon={menu}
          onMenuBarVisibilityChange={setMenu}
          desktopNotifications={notifications}
          onDesktopNotificationsChange={(next) =>
            setNotifications((current) => ({ ...current, ...next }))
          }
          modelFollow={follow}
          onModelFollowChange={setFollow}
          mainColor={colors[0]}
          secondaryColor={colors[1]}
          updateState={updateState}
          onCheckForUpdates={() => setResult("Checked for updates (preview)")}
          onUpdateAction={(state) =>
            setResult(`Update action: ${state.status}`)
          }
          onAppearanceColorsChange={(main, secondary) =>
            setColors([main, secondary])
          }
        />
      </AppChrome>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
