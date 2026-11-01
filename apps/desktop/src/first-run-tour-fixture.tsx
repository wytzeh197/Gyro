// Development-only production-component fixture. All config and conversation
// state is local sample data. No IPC, account connections, or provider calls.
// ?theme=dark|light&zoom=1|1.1&size=default|large&provider=connected|none
// &scene=home|thread&split=1 covers real home, active-chat and split layouts.
// &panel=files includes the real companion tab header for the panel step.
// &missing=panel omits that anchor before the tour catalog is resolved.
// &suggestion=shown|saving|error opts into the nonmodal model-default card.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  ChatGridSurface,
  ChatSurface,
  FirstRunTour,
  ModelStandardPromptOverlay,
  SettingsSurface,
  applyAppearancePreferences,
  chatGridReducer,
  createChatProjectLayout,
  providersForConfig,
  type AppDestination,
  type ChatGridState,
  type ChatPaneRef,
  type GyroConfig,
  type Session,
  type SessionEvent,
  type SettingsSectionId,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "../../../packages/ui/src/appearance.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
const interfaceSize = query.get("size") === "large" ? "large" : "default";
const zoom = query.get("zoom") === "1.1" ? 1.1 : 1;
const providerConfigured = query.get("provider") !== "none";
const scene = query.get("scene") === "thread" ? "thread" : "home";
const workspace = "/fixture/aurora";
const paneForId = (id: string): ChatPaneRef =>
  scene === "thread"
    ? { kind: "session", paneId: id, sessionId: id, workspacePath: workspace }
    : { kind: "draft", paneId: id, draftKey: id, workspacePath: workspace };
const mainPane = paneForId("main");
const session: Session = {
  id: "main",
  title: "Bound the sync retries",
  workspacePath: workspace,
  origin: "desktop",
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  eventsPath: "/fixture/events.jsonl",
};
const threadEvents: SessionEvent[] = [
  {
    id: "request",
    sessionId: "main",
    turnId: "sample",
    createdAt: session.createdAt,
    kind: "user-message",
    message: "Bound the retry loop and cover the limit with a test.",
    payload: {},
  },
  {
    id: "answer",
    sessionId: "main",
    turnId: "sample",
    createdAt: session.createdAt,
    kind: "assistant-message",
    message:
      "## Ready to review\n\nThe queue now stops after **5 attempts** and backs off between retries.\n\nThe test covers the retry limit and preserves the final error.",
    payload: {},
  },
];
const emptyConfig: GyroConfig = {
  modelProviders: [],
  commandProfiles: [],
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: providerConfigured ? "anthropic" : undefined,
  modelProviders: providersForConfig(emptyConfig).map((provider) => ({
    ...provider,
    enabled: providerConfigured && provider.id === "anthropic",
    authStatus:
      providerConfigured && provider.id === "anthropic"
        ? "connected"
        : provider.authStatus,
  })),
};

function Fixture() {
  const [destination, setDestination] = useState<AppDestination>("workspace");
  const [section, setSection] = useState<SettingsSectionId>("general");
  const [draft, setDraft] = useState("");
  const [environment, setEnvironment] = useState(false);
  const [panelOpen, setPanelOpen] = useState(query.get("panel") === "files");
  const suggestion = query.get("suggestion");
  const [suggestionVisible, setSuggestionVisible] = useState(
    Boolean(suggestion) && query.get("delayed") !== "1",
  );
  const [suggestionSaving, setSuggestionSaving] = useState(
    suggestion === "saving",
  );
  const [suggestionError, setSuggestionError] = useState(
    suggestion === "error" ? "Couldn’t save the default model. Try again." : "",
  );
  useEffect(() => {
    if (!suggestion || query.get("delayed") !== "1") return;
    const timer = window.setTimeout(() => setSuggestionVisible(true), 600);
    return () => window.clearTimeout(timer);
  }, [suggestion]);
  const recordSuggestionAction = (action: string) => {
    document.documentElement.dataset.modelSuggestionAction = action;
    setSuggestionVisible(false);
  };
  const [grid, dispatch] = useReducer(chatGridReducer, undefined, () => {
    const initial: ChatGridState = {
      activeProjectKey: workspace,
      layouts: { [workspace]: createChatProjectLayout(workspace, mainPane) },
    };
    return query.get("split") === "1"
      ? chatGridReducer(initial, {
          type: "select-pane",
          projectKey: workspace,
          mode: "drop",
          slotIndex: 0,
          insertPosition: "after",
          splitDirection: "horizontal",
          arrangement: "columns",
          pane: paneForId("secondary"),
        })
      : initial;
  });
  // Each page load starts a fresh tour without touching Gyro's saved tour key.
  const storage = useMemo(() => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
        document.documentElement.dataset.tourFixtureRecord = value;
      },
    };
  }, []);
  const openSettings = useCallback((nextSection: SettingsSectionId) => {
    setSection(nextSection);
    setDestination("settings");
  }, []);

  useLayoutEffect(() => {
    applyAppearancePreferences(
      document.documentElement,
      {
        interfaceSize,
        mainColor: "#0874df",
        secondaryColor: "#8b6fcb",
        motionSpeed: "default",
      },
      theme,
    );
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = "compact";
    document.documentElement.dataset.firstRunTourFixture = "true";
    document.body.style.zoom = String(zoom);
    document.documentElement.style.setProperty(
      "--tour-fixture-zoom",
      String(zoom),
    );
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.tourFixtureDestination = destination;
    document.documentElement.dataset.tourFixtureSection = section;
  }, [destination, section]);

  const renderChat = (pane: ChatPaneRef, isTiled = false) => (
    <ChatSurface
      key={pane.paneId}
      activeChatPanel={panelOpen ? "files" : undefined}
      branchName="main"
      companionTabs={panelOpen ? ["files"] : []}
      config={config}
      draft={draft}
      events={scene === "thread" ? threadEvents : []}
      isEnvironmentRailOpen={environment}
      isTiled={isTiled}
      onComposerAction={() => {}}
      onCloseCompanionDock={() => setPanelOpen(false)}
      onDraftChange={setDraft}
      onSend={() => setDraft("")}
      onOpenCompanionTab={() => setPanelOpen(true)}
      onSelectChatPanel={(panel) => setPanelOpen(Boolean(panel))}
      onToggleEnvironmentRail={() => setEnvironment((value) => !value)}
      paneKey={pane.paneId}
      sessionTitle={session.title}
      sessionModel={
        providerConfigured
          ? {
              providerId: "anthropic",
              modelId: "claude-opus-5",
              modelLabel: "Claude Opus 5",
              reasoningEffort: "high",
            }
          : undefined
      }
      shellReady
      workspacePath={workspace}
    />
  );

  return (
    <>
      <style>{`
        .tour-fixture-stage { height:calc(100dvh / var(--tour-fixture-zoom,1)); width:calc(100vw / var(--tour-fixture-zoom,1)); min-height:0; overflow:hidden; }
        .tour-fixture-stage > .gyro-app-shell { height:100%; min-height:0; grid-template-rows:minmax(0,1fr); }
        .tour-fixture-stage .gyro-main, .tour-fixture-stage .gyro-sidebar { height:100%; max-height:100%; min-height:0; }
        ${query.get("missing") === "panel" ? '[data-tour="panel.launcher"], [data-tour="panel.tabs"] { display:none !important; }' : ""}
      `}</style>
      <main className="tour-fixture-stage">
        <AppChrome
          activeDestination={destination}
          activeSessionId={scene === "thread" ? "main" : undefined}
          activeWorkspaceLayout="thread"
          activeSettingsSection={section}
          commandProfiles={[]}
          savedProjects={[]}
          sessions={scene === "thread" ? [session] : []}
          workspacePath={workspace}
          onCreateSession={() => setDraft("")}
          onCreateCliSession={() => {}}
          onOpenCommandPalette={() => {}}
          onOpenSettings={() => openSettings("general")}
          onOpenSettingsSection={openSettings}
          onOpenToolPanel={() => setEnvironment(true)}
          onOpenWorkspace={() => setDestination("workspace")}
          onSelectDestination={setDestination}
          onSelectSessions={() => setDestination("workspace")}
          onSelectWorkspaceLayout={() => setDestination("workspace")}
          onSelectSession={() => setDestination("workspace")}
        >
          {destination === "settings" ? (
            <SettingsSurface
              activeSection={section}
              config={config}
              interfaceSize={interfaceSize}
              onSectionChange={setSection}
              onThemeChange={() => {}}
              themeMode={theme}
            />
          ) : (
            <ChatGridSurface
              layout={grid.layouts[workspace]!}
              maximizedPaneId={grid.maximizedPaneId}
              onDropSession={(sessionId, _source, slotIndex, placement) =>
                dispatch({
                  type: "select-pane",
                  projectKey: workspace,
                  mode: "drop",
                  slotIndex,
                  pane: {
                    kind: "session",
                    paneId: sessionId,
                    sessionId,
                    workspacePath: workspace,
                  },
                  ...placement,
                })
              }
              onFocusPane={(pane) =>
                dispatch({
                  type: "focus-pane",
                  projectKey: workspace,
                  paneId: pane.paneId,
                })
              }
              onMovePane={(paneId, slotIndex) =>
                dispatch({
                  type: "move-pane",
                  projectKey: workspace,
                  paneId,
                  slotIndex,
                })
              }
              onToggleMaximize={(paneId) =>
                dispatch({ type: "toggle-maximize-pane", paneId })
              }
              renderPane={(pane, options) => renderChat(pane, options.isTiled)}
            >
              {renderChat(mainPane)}
            </ChatGridSurface>
          )}
        </AppChrome>
      </main>
      {suggestion ? (
        suggestionVisible && (
          <ModelStandardPromptOverlay
            modelLabel={
              query.get("long") === "1"
                ? "A custom model with an exceptionally long descriptive name"
                : "Claude Opus 5"
            }
            providerId="anthropic"
            providerLabel="Anthropic"
            usageCount={8}
            chatCount={3}
            onAccept={() => {
              setSuggestionError("");
              setSuggestionSaving(true);
              document.documentElement.dataset.modelSuggestionAction = "accept";
            }}
            onDismiss={() => recordSuggestionAction("dismiss")}
            onNeverSuggest={() => recordSuggestionAction("never")}
            isSaving={suggestionSaving}
            error={suggestionError}
          />
        )
      ) : (
        <FirstRunTour
          destination={destination}
          onNavigate={setDestination}
          onOpenSettings={openSettings}
          providerConfigured={providerConfigured}
          storage={storage}
        />
      )}
    </>
  );
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
