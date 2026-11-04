import { BILLING_SCENES, useBillingPreview } from "./billing-preview";
import { createInitialWorkbenchState, workbenchReducer, type WorkbenchAction } from "@gyro-dev/ui";
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
  type LaunchView,
  type ProviderId,
  type SettingsSectionId,
  type UpdateState,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { projectImportPreview } from "./project-import-preview";
import { readBoundedLocalStorage, safeSetLocalStorage } from "./ui-storage";
import { installAccountFixture } from "./account-fixture";
import {
  AccountNavigation,
  AccountSettings,
  CloudSettings,
  useGyroAccount,
} from "./account-settings";
import { GyroCloud } from "./gyro-cloud";
import { useAppearanceSaveFeedback } from "./use-appearance-save-feedback";

const params = new URLSearchParams(location.search);
// ?account=signed-out|new|locked|ready|empty|unavailable adds the Account and
// Cloud pages, answered by a fixture backend.
const accountScene = params.get("account");
if (accountScene) installAccountFixture(accountScene);
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
  if (["light", "dark"].includes(params.get("theme") ?? "")) initial.theme = params.get("theme") as ThemeMode;
  if (["compact", "comfortable"].includes(params.get("density") ?? "")) initial.density = params.get("density") as PreviewAppearance["density"];
  if (["small", "default", "large"].includes(params.get("size") ?? "")) initial.interfaceSize = params.get("size") as PreviewAppearance["interfaceSize"];
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
  const billing = useBillingPreview();
  const [extraPreferences, setExtraPreferences] = useState(() => {
    const base = createInitialWorkbenchState().preferences;
    try { const raw = localStorage.getItem("gyro.settings-preview.preferences"); return raw && raw.length < 65536 ? { ...base, ...JSON.parse(raw) } as WorkbenchPreferences : base; } catch { return base; }
  });
  const updateFixturePreference = (action: WorkbenchAction) => setExtraPreferences(current => workbenchReducer(createInitialWorkbenchState({ preferences: current }), action).preferences);
  const [toolFixture, setToolFixture] = useState(createInitialWorkbenchState);

  const [initial] = useState(loadPreviewAppearance);
  const [theme, setTheme] = useState<ThemeMode>(initial.theme);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [defaultWorkspaceMode, setDefaultWorkspaceMode] = useState<
    "local" | "worktree"
  >(extraPreferences.defaultWorkspaceMode);
  const [launchView, setLaunchView] = useState<LaunchView>(
    () => (params.get("launch") as LaunchView | null) ?? extraPreferences.launchView,
  );
  const [failSave, setFailSave] = useState(params.has("failSave"));
  const failSaveRef = useRef(failSave);
  failSaveRef.current = failSave;
  const [scene] = useState(() =>
    new URLSearchParams(location.search).get("scene"),
  );

  const [section, setSection] = useState<SettingsSectionId>(
    (new URLSearchParams(location.search).get("section") as
      | SettingsSectionId
      | null) ??
      (scene === "providers"
        ? "providers"
        : scene === "efficiency"
          ? "efficiency"
          : scene === "updates"
          ? "updates"
          : scene === "import"
            ? "import-projects"
            : scene === "general"
              ? "general"
              : "appearance"),
  );
  const account = useGyroAccount();
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
  const [menu, setMenu] = useState(extraPreferences.showMenuBarIcon);
  const [notifications, setNotifications] =
    useState<DesktopNotificationPreferences>(extraPreferences.desktopNotifications);
  const [follow, setFollow] = useState<"off" | "peek" | "follow">(extraPreferences.modelFollow);
  useEffect(() => { safeSetLocalStorage("gyro.settings-preview.preferences", JSON.stringify({...extraPreferences, desktopNotifications: notifications, showMenuBarIcon: menu, modelFollow: follow, launchView, defaultWorkspaceMode})); }, [extraPreferences, notifications, menu, follow, launchView, defaultWorkspaceMode]);
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
          // Query-seeded connections are sample state, never live sign-ins.
          enabled: params.get("connected")?.split(",").includes(provider.id) ?? false,
          authStatus: params.get("connected")?.split(",").includes(provider.id)
            ? "connected" as const
            : "not-connected" as const,
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
    <div className="gyro-settings-preview" data-reduced-motion={reduceMotion} data-capture={params.has("capture") || undefined}>
      <style>{`
        html, body, #root { height: 100%; margin: 0; }
        .gyro-settings-preview { height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--gyro-pane); color: var(--gyro-text); }
        .gyro-settings-preview[data-reduced-motion="true"] *, .gyro-settings-preview[data-reduced-motion="true"] *::before, .gyro-settings-preview[data-reduced-motion="true"] *::after { animation-duration: 0.01ms !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; }
        .gyro-settings-preview > .gyro-app-shell { height: 100%; min-height: 0; grid-template-rows: minmax(0, 1fr); }
        .gyro-settings-preview .gyro-workspace-activity-rail { min-height: 0; }
        :root[data-theme] .gyro-settings-preview .gyro-app-shell.is-workspace-shell > .gyro-main, :root[data-theme] .gyro-settings-preview .gyro-app-shell.is-workspace-shell > .gyro-sidebar { height: 100%; min-height: 0; }
        /* Optional document-scroll mode for full-page production-component captures. */
        html:has(.gyro-settings-preview[data-capture]), body:has(.gyro-settings-preview[data-capture]), #root:has(.gyro-settings-preview[data-capture]) { height: auto; overflow: visible; }
        .gyro-settings-preview[data-capture] { height: auto; min-height: 100dvh; overflow: visible; }
        .gyro-settings-preview[data-capture] > .gyro-app-shell { height: auto; min-height: 100dvh; overflow: visible; }
        :root[data-theme] .gyro-settings-preview[data-capture] .gyro-app-shell > .gyro-main { height: auto; max-height: none; overflow: visible; }
        :root[data-theme] .gyro-settings-preview[data-capture] .gyro-app-shell.is-settings-layout > .gyro-main > .gyro-settings-surface { overflow: visible; flex: none; }
        :root[data-theme] .gyro-settings-preview[data-capture] .gyro-app-shell > .gyro-sidebar { position: sticky; top: 0; align-self: start; height: 100dvh; }
        .gyro-settings-preview-account-form { position: fixed; z-index: 500; top: 15%; left: 50%; transform: translateX(-50%); width: min(480px, calc(100vw - 40px)); padding: 24px; background: var(--gyro-pane); border: 1px solid var(--gyro-border); border-radius: 12px; box-shadow: 0 12px 80px #0004; }
        .gyro-settings-preview-account-form input { display: block; width: 100%; margin: 16px 0; }
        .gyro-settings-preview-portal-backdrop { position: fixed; inset: 0; z-index: 500; background: #0005; }
        .gyro-settings-preview-portal-backdrop .gyro-settings-preview-account-form { max-height: 80vh; overflow: auto; top: 10%; }
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
        {section === "billing" ? <><select aria-label="Billing fixture state" value={billing.snapshot.status} onChange={e=>billing.setScene(e.target.value as typeof billing.snapshot.status)}>{BILLING_SCENES.map(status=><option key={status}>{status}</option>)}</select><button onClick={billing.cancel}>Simulate cancellation</button></> : null}
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
        accountNavigation={
          accountScene ? (
            <AccountNavigation
              account={account}
              selected={section}
              onSelect={setSection}
            />
          ) : undefined
        }
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
        {section === "billing" ? billing.accountForm : null}
        <SettingsSurface
          accountSettings={<AccountSettings account={account} />}
          cloudSettings={accountScene ? (
            <CloudSettings
              account={account}
              onAccount={() => setSection("account")}
            />
          ) : undefined}
          preferences={{ ...extraPreferences, theme, density, interfaceSize, motionSpeed, mainColor: colors[0]!, secondaryColor: colors[1]!, desktopNotifications: notifications, launchView, showMenuBarIcon: menu, modelFollow: follow, defaultWorkspaceMode }}
          onSettingsPreferencesChange={patch => setExtraPreferences(current=>({...current,...patch}))}
          onImportSettings={settings => { setExtraPreferences(current=>({...current,...settings})); if(settings.theme)setTheme(settings.theme); if(settings.density)setDensity(settings.density); if(settings.interfaceSize)setInterfaceSize(settings.interfaceSize); if(settings.motionSpeed)setMotionSpeed(settings.motionSpeed); if(settings.mainColor||settings.secondaryColor)setColors([settings.mainColor??colors[0]!,settings.secondaryColor??colors[1]!]); if(settings.desktopNotifications)setNotifications(settings.desktopNotifications); if(settings.launchView)setLaunchView(settings.launchView); if(settings.showMenuBarIcon!==undefined)setMenu(settings.showMenuBarIcon); if(settings.modelFollow)setFollow(settings.modelFollow); }}
          billingSnapshot={billing.snapshot}
          billingActions={billing.actions}
          systemAccess={[{id:"documents",label:"Documents",reason:"Fixture access status",status:"granted",path:"/fixture/Documents",canPrompt:false,settingsUrl:""},{id:"full-disk",label:"Full Disk Access",reason:"Fixture access status",status:"unavailable",canPrompt:false,settingsUrl:""}]}
          onRecheckSystemAccess={()=>setResult("Simulated access check; no macOS permission request.")}
          onOpenSystemAccessSettings={()=>setResult("System Settings would open in the native app.")}
          projectImport={{...projectImportPreview(updateScene, setResult),onScan:()=>setUpdateScene("scanned"),onImport:()=>setUpdateScene("completed"),onCancel:()=>setUpdateScene("scanned")}}
          config={config}
          workspacePath="/fixture/Gyro"
          workspaceRoots={["/fixture/Gyro"]}
          onConfigChange={setConfig}
          onEfficiencyChange={async efficiency=>setConfig(current=>({...current,efficiency}))}
          onAutoCompactPercentChange={autoCompactPercent=>setConfig(current=>({...current,usageGuard:{enabled:true,pause:{active:false,scope:"all"},budgets:[],windowMinutes:60,maxCallsPerWindow:0,maxUnattendedCallsPerWindow:0,maxTokensPerCall:0,maxToolRounds:0,maxResynthesesPerWindow:0,...current.usageGuard,autoCompactPercent}}))}
          cliLaunchPreset={extraPreferences.cliLaunchPreset}
          onCliLaunchPresetChange={preset=>updateFixturePreference({type:"set-cli-launch-preset",preset})}
          workspaceKeybindings={extraPreferences.workspaceKeybindings}
          workspaceUserSettings={extraPreferences.workspaceUserSettings}
          workspaceSettingsByWorkspace={extraPreferences.workspaceSettingsByWorkspace}
          workspaceSettingsByFolder={extraPreferences.workspaceSettingsByFolder}
          onWorkspaceKeybindingChange={(commandId,keybinding)=>updateFixturePreference({type:"set-workspace-keybinding",commandId,keybinding})}
          onWorkspaceSettingsChange={(scope,path,settings)=>updateFixturePreference({type:"set-workspace-settings",scope,path,settings})}
          workspaceContributions={toolFixture.ide.contributions}
          workspaceLanguageServers={toolFixture.ide.languageServers}
          onRegisterWorkspaceContribution={contribution=>setToolFixture(current=>workbenchReducer(current,{type:"ide-register-contribution",contribution}))}
          onToggleWorkspaceContribution={(id,enabled)=>setToolFixture(current=>workbenchReducer(current,{type:"ide-set-contribution-enabled",id,enabled}))}
          onRemoveWorkspaceContribution={id=>setToolFixture(current=>workbenchReducer(current,{type:"ide-remove-contribution",id}))}
          onExportDiagnostics={()=>setResult("Diagnostics export is simulated. No local files were read.")}
          onResetUiState={()=>{setExtraPreferences(createInitialWorkbenchState().preferences);setResult("Fixture presentation preferences reset.");}}
          onTestNotification={()=>setResult(notifications.showNames === false ? "Generic test notification (simulated)" : "Test notification (simulated)")}

          onSectionChange={setSection}
          defaultWorkspaceMode={defaultWorkspaceMode}
          onDefaultWorkspaceModeChange={setDefaultWorkspaceMode}
          launchView={launchView}
          onLaunchViewChange={(next) => {
            setLaunchView(next);
            setResult(`Open on launch: ${next}`);
          }}
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
      {params.has("cloudDialog") ? (
        <GyroCloud uploadId="chat-1" onStatus={account.setStatus} onClose={() => {}} />
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
