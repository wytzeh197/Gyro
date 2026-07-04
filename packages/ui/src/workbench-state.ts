import type {
  AppDestination,
  Automation,
  AutomationStatus,
  AutomationTriageState,
  BrowserPreviewDevice,
  BrowserPreviewStatus,
  CommandProfile,
  DiffApprovalState,
  DiffFileState,
  DiffSource,
  GitReviewAction,
  GitReviewActionId,
  Notification,
  NotificationKind,
  OnboardingStepId,
  ProviderConnectionStatus,
  ProviderHandoff,
  ProviderSession,
  ProviderSessionStatus,
  ProviderStatus,
  ProviderReadinessStatus,
  SettingsSectionId,
  SurfaceId,
  Task,
  TaskStatus,
  TerminalPane,
  TerminalPaneStatus,
  TerminalTemplate,
  ThemeMode,
  WorkbenchDensity,
  WorkbenchMode,
  WorkbenchPaneTab,
  WorkbenchState,
  WorkbenchTurn,
} from "./types";

export type WorkbenchAction =
  | { type: "reset-state"; state?: WorkbenchState }
  | { type: "select-destination"; destination: AppDestination }
  | { type: "select-surface"; surface: SurfaceId }
  | { type: "set-pane-tab"; tab: WorkbenchPaneTab }
  | { type: "set-workbench-mode"; mode: WorkbenchMode }
  | { type: "set-theme"; theme: ThemeMode }
  | { type: "set-density"; density: WorkbenchDensity }
  | { type: "set-settings-section"; section: SettingsSectionId }
  | { type: "toggle-sidebar-chats" }
  | { type: "toggle-chat-environment-rail" }
  | { type: "set-chat-environment-rail"; open: boolean }
  | { type: "record-command"; commandId: string }
  | { type: "add-notification"; notification: Notification }
  | { type: "dismiss-notification"; id: string }
  | { type: "clear-notifications" }
  | { type: "select-terminal-pane"; paneId: string }
  | { type: "add-terminal-pane"; pane: TerminalPane }
  | {
      type: "split-terminal-pane";
      pane: TerminalPane;
      template: TerminalTemplate;
    }
  | { type: "set-terminal-template"; template: TerminalTemplate }
  | {
      type: "set-terminal-pane-status";
      paneId: string;
      status: TerminalPaneStatus;
      event: string;
    }
  | {
      type: "sync-terminal-pane-snapshot";
      paneId: string;
      output: string;
      status: TerminalPaneStatus;
      event: string;
      command?: string;
    }
  | {
      type: "upsert-restored-terminal-pane";
      pane: TerminalPane;
    }
  | {
      type: "run-terminal-pane";
      paneId: string;
      profileId: string;
      command: string;
      output: string;
    }
  | { type: "rename-terminal-pane"; paneId: string; title: string }
  | { type: "select-task"; taskId: string }
  | { type: "create-task"; task: Task }
  | { type: "move-task"; taskId: string; status: TaskStatus; event: string }
  | { type: "dispatch-task"; taskId: string; pane: TerminalPane }
  | { type: "set-automations"; automations: Automation[] }
  | { type: "upsert-automation"; automation: Automation }
  | { type: "select-automation"; automationId: string }
  | { type: "create-automation"; automation: Automation }
  | {
      type: "set-automation-status";
      automationId: string;
      status: AutomationStatus;
    }
  | { type: "run-automation"; automationId: string; summary: string }
  | {
      type: "triage-automation";
      automationId: string;
      triageState: AutomationTriageState;
    }
  | {
      type: "sync-diff-event";
      path: string;
      message: string;
      source?: DiffSource;
      turnId?: string;
    }
  | { type: "select-diff-file"; path: string }
  | { type: "toggle-diff-directory"; directory: string }
  | { type: "run-git-review-action"; actionId: GitReviewActionId }
  | {
      type: "set-diff-file-state";
      path: string;
      state: DiffFileState;
      action: string;
    }
  | { type: "set-diff-review-state"; state: DiffApprovalState; action: string }
  | { type: "undo-diff-action"; action: string }
  | { type: "add-diff-comment"; path: string }
  | { type: "set-browser-url"; url: string }
  | { type: "browser-navigate"; url: string; status?: BrowserPreviewStatus }
  | { type: "browser-back" }
  | { type: "browser-forward" }
  | { type: "browser-reload" }
  | { type: "browser-device"; device: BrowserPreviewDevice }
  | { type: "browser-screenshot" }
  | {
      type: "browser-status";
      status: BrowserPreviewStatus;
      message: string;
      consoleErrors?: number;
    }
  | {
      type: "set-provider-status";
      providerId: string;
      status: ProviderConnectionStatus;
    }
  | {
      type: "record-provider-health";
      providerId: string;
      status: ProviderConnectionStatus;
      summary: string;
      output: string;
    }
  | {
      type: "set-provider-readiness";
      status: ProviderReadinessStatus;
      message: string;
      providerId?: string;
    }
  | { type: "set-provider-model"; providerId: string; model: string }
  | {
      type: "queue-provider-handoff";
      handoff: ProviderHandoff;
      session: ProviderSession;
    }
  | {
      type: "set-provider-session-status";
      sessionId: string;
      status: ProviderSessionStatus;
      event: string;
    }
  | { type: "reconcile-active-turn"; turn?: WorkbenchTurn }
  | { type: "reconcile-active-turn-timeout"; now: string; idleMs: number }
  | { type: "set-onboarding-step"; step: OnboardingStepId }
  | { type: "complete-onboarding-step"; step: OnboardingStepId };

export function createInitialWorkbenchState(
  overrides: Partial<WorkbenchState> = {},
): WorkbenchState {
  const terminalPanes = (overrides.terminalPanes ?? defaultTerminalPanes()).map(
    normalizeTerminalPane,
  );
  const tasks = (overrides.tasks ?? defaultTasks()).map(normalizeTask);
  const automations = (overrides.automations ?? defaultAutomations()).map(
    normalizeAutomation,
  );
  const providerSessions = (overrides.providerSessions ?? []).map(
    normalizeProviderSession,
  );
  const providerHandoffs = (overrides.providerHandoffs ?? []).map(
    normalizeProviderHandoff,
  );
  const diffReview = normalizeDiffReview(
    overrides.diffReview ?? defaultDiffReview(),
  );

  return {
    activeDestination: "chat",
    activePaneTab: "terminal",
    workspaceMode: "local",
    terminalTemplate: 4,
    selectedTaskId: undefined,
    diffReview,
    browserPreview: defaultBrowserPreview(),
    notifications: defaultNotifications(),
    providerStatuses: defaultProviderStatuses(),
    providerSessions,
    providerHandoffs,
    providerReadiness: defaultProviderReadiness(),
    activeTurn: overrides.activeTurn,
    onboarding: {
      activeStep: "welcome",
      completedSteps: [],
    },
    preferences: {
      theme: "dark",
      density: "compact",
      lastSettingsSection: "general",
      commandPaletteRecents: [],
      sidebarChatsCollapsed: false,
      chatEnvironmentRailOpen: false,
    },
    ...overrides,
    selectedTerminalPaneId:
      overrides.selectedTerminalPaneId ?? terminalPanes[0]?.id ?? "",
    terminalPanes,
    tasks,
    automations,
    selectedProviderSessionId:
      overrides.selectedProviderSessionId &&
      providerSessions.some(
        (session) => session.id === overrides.selectedProviderSessionId,
      )
        ? overrides.selectedProviderSessionId
        : providerSessions[0]?.id,
  };
}

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "reset-state":
      return action.state ?? createInitialWorkbenchState();
    case "select-destination":
      return { ...state, activeDestination: action.destination };
    case "select-surface":
      return { ...state, activeDestination: action.surface };
    case "set-pane-tab":
      return { ...state, activePaneTab: action.tab };
    case "set-workbench-mode":
      return { ...state, workspaceMode: action.mode };
    case "set-theme":
      return {
        ...state,
        preferences: { ...state.preferences, theme: action.theme },
      };
    case "set-density":
      return {
        ...state,
        preferences: { ...state.preferences, density: action.density },
      };
    case "set-settings-section":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          lastSettingsSection: action.section,
        },
      };
    case "toggle-sidebar-chats":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          sidebarChatsCollapsed: !state.preferences.sidebarChatsCollapsed,
        },
      };
    case "toggle-chat-environment-rail":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          chatEnvironmentRailOpen: !state.preferences.chatEnvironmentRailOpen,
        },
      };
    case "set-chat-environment-rail":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          chatEnvironmentRailOpen: action.open,
        },
      };
    case "record-command":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          commandPaletteRecents: [
            action.commandId,
            ...state.preferences.commandPaletteRecents.filter(
              (commandId) => commandId !== action.commandId,
            ),
          ].slice(0, 6),
        },
      };
    case "add-notification":
      return {
        ...state,
        notifications: [action.notification, ...state.notifications].slice(
          0,
          12,
        ),
      };
    case "dismiss-notification":
      return {
        ...state,
        notifications: state.notifications.map((notification) =>
          notification.id === action.id
            ? { ...notification, read: true }
            : notification,
        ),
      };
    case "clear-notifications":
      return {
        ...state,
        notifications: state.notifications.map((notification) => ({
          ...notification,
          read: true,
        })),
      };
    case "select-terminal-pane":
      return { ...state, selectedTerminalPaneId: action.paneId };
    case "add-terminal-pane":
      return {
        ...state,
        activeDestination: "cli",
        activePaneTab: "terminal",
        selectedTerminalPaneId: action.pane.id,
        terminalPanes: [...state.terminalPanes, action.pane],
      };
    case "split-terminal-pane":
      return {
        ...state,
        activeDestination: "cli",
        activePaneTab: "terminal",
        selectedTerminalPaneId: action.pane.id,
        terminalTemplate: action.template,
        terminalPanes: [...state.terminalPanes, action.pane],
      };
    case "set-terminal-template":
      return { ...state, terminalTemplate: action.template };
    case "set-terminal-pane-status":
      return {
        ...state,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? { ...pane, status: action.status, lastEvent: action.event }
            : pane,
        ),
      };
    case "sync-terminal-pane-snapshot":
      return {
        ...state,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? {
                ...pane,
                command: action.command ?? pane.command,
                lastEvent: action.event,
                output: action.output,
                status: action.status,
              }
            : pane,
        ),
      };
    case "upsert-restored-terminal-pane": {
      const pane = normalizeTerminalPane(action.pane);
      const exists = state.terminalPanes.some((item) => item.id === pane.id);
      return {
        ...state,
        selectedTerminalPaneId: state.selectedTerminalPaneId || pane.id,
        terminalPanes: exists
          ? state.terminalPanes.map((item) =>
              item.id === pane.id ? { ...item, ...pane } : item,
            )
          : [...state.terminalPanes, pane],
      };
    }
    case "run-terminal-pane":
      return {
        ...state,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? {
                ...pane,
                command: action.command,
                lastEvent: "command queued",
                output: action.output,
                profileId: action.profileId,
                status: "waiting",
              }
            : pane,
        ),
      };
    case "rename-terminal-pane":
      return {
        ...state,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId ? { ...pane, title: action.title } : pane,
        ),
      };
    case "select-task":
      return { ...state, selectedTaskId: action.taskId };
    case "create-task":
      return {
        ...state,
        selectedTaskId: action.task.id,
        tasks: [action.task, ...state.tasks],
      };
    case "move-task":
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.taskId
            ? { ...task, lastEvent: action.event, status: action.status }
            : task,
        ),
      };
    case "dispatch-task":
      return {
        ...workbenchReducer(state, {
          type: "add-terminal-pane",
          pane: action.pane,
        }),
        selectedTaskId: action.taskId,
        tasks: state.tasks.map((task) =>
          task.id === action.taskId
            ? {
                ...task,
                attentionNeeded: true,
                lastEvent:
                  action.pane.workspaceMode === "worktree" &&
                  action.pane.worktreeName
                    ? `dispatched to ${action.pane.worktreeName}`
                    : "dispatched to terminal pane",
                status: "in-progress",
                terminalPaneId: action.pane.id,
              }
            : task,
        ),
      };
    case "set-automations": {
      const automations = action.automations.map(normalizeAutomation);
      return {
        ...state,
        automations,
        selectedAutomationId:
          state.selectedAutomationId &&
          automations.some(
            (automation) => automation.id === state.selectedAutomationId,
          )
            ? state.selectedAutomationId
            : automations[0]?.id,
      };
    }
    case "upsert-automation": {
      const automation = normalizeAutomation(action.automation);
      const exists = state.automations.some(
        (item) => item.id === automation.id,
      );
      return {
        ...state,
        selectedAutomationId: automation.id,
        automations: exists
          ? state.automations.map((item) =>
              item.id === automation.id ? automation : item,
            )
          : [automation, ...state.automations],
      };
    }
    case "select-automation":
      return {
        ...state,
        activeDestination: "automations",
        selectedAutomationId: action.automationId,
      };
    case "create-automation":
      return {
        ...state,
        activeDestination: "automations",
        selectedAutomationId: action.automation.id,
        automations: [action.automation, ...state.automations],
      };
    case "set-automation-status":
      return {
        ...state,
        automations: state.automations.map((automation) =>
          automation.id === action.automationId
            ? {
                ...automation,
                status: action.status,
                nextRunAt:
                  action.status === "paused" || action.status === "completed"
                    ? undefined
                    : (automation.nextRunAt ?? nextAutomationRunAt()),
              }
            : automation,
        ),
      };
    case "run-automation": {
      const now = new Date().toISOString();
      return {
        ...state,
        activeDestination: "automations",
        selectedAutomationId: action.automationId,
        automations: state.automations.map((automation) =>
          automation.id === action.automationId
            ? {
                ...automation,
                lastRunAt: now,
                lastResult: action.summary,
                nextRunAt:
                  automation.status === "current"
                    ? nextAutomationRunAt()
                    : automation.nextRunAt,
                triageState: "needs-review",
                unreadResults: automation.unreadResults + 1,
                runHistory: [
                  {
                    id: `run-${Date.now()}`,
                    status: "passed" as const,
                    startedAt: now,
                    finishedAt: now,
                    summary: action.summary,
                  },
                  ...automation.runHistory,
                ].slice(0, 8),
              }
            : automation,
        ),
      };
    }
    case "triage-automation":
      return {
        ...state,
        automations: state.automations.map((automation) =>
          automation.id === action.automationId
            ? {
                ...automation,
                triageState: action.triageState,
                unreadResults:
                  action.triageState === "archived"
                    ? 0
                    : automation.unreadResults,
              }
            : automation,
        ),
      };
    case "sync-diff-event": {
      if (
        state.activeTurn?.id &&
        action.turnId &&
        action.turnId !== state.activeTurn.id
      ) {
        return state;
      }
      const existing = state.diffReview.files.find(
        (file) => file.path === action.path,
      );
      const files = existing
        ? state.diffReview.files.map((file) =>
            file.path === action.path
              ? {
                  ...file,
                  source: action.source ?? file.source,
                  state: "pending" as const,
                  turnId: action.turnId ?? file.turnId,
                }
              : file,
          )
        : [
            ...state.diffReview.files,
            {
              path: action.path,
              additions: 1,
              deletions: 1,
              source: action.source ?? "agent-generated",
              state: "pending" as const,
              turnId: action.turnId,
              comments: 0,
              lines: [
                {
                  number: 1,
                  kind: "removed" as const,
                  content: "- pending proposed edit",
                },
                {
                  number: 1,
                  kind: "added" as const,
                  content: "+ approval-gated proposed edit",
                },
              ],
            },
          ];

      return {
        ...state,
        activeDestination:
          state.activeDestination === "cli" ? "cli" : state.activeDestination,
        activePaneTab:
          state.activeDestination === "cli" ? "diff" : state.activePaneTab,
        diffReview: {
          ...normalizeDiffReview(state.diffReview),
          activeTurnId: action.turnId ?? state.diffReview.activeTurnId,
          approvalState: "pending",
          files,
          lastAction: action.message,
          selectedPath: action.path,
        },
        activeTurn: state.activeTurn
          ? {
              ...state.activeTurn,
              changedFiles: files.filter(
                (file) =>
                  !action.turnId ||
                  file.turnId === action.turnId ||
                  file.path === action.path,
              ).length,
              lastEvent: action.message,
              status: "waiting",
              updatedAt: new Date().toISOString(),
            }
          : state.activeTurn,
      };
    }
    case "select-diff-file":
      return {
        ...state,
        activeDestination: state.activeDestination === "cli" ? "cli" : "diff",
        activePaneTab:
          state.activeDestination === "cli" ? "diff" : state.activePaneTab,
        diffReview: {
          ...state.diffReview,
          collapsedDirectories: expandedParentDirectories(
            state.diffReview.collapsedDirectories,
            action.path,
          ),
          selectedPath: action.path,
        },
      };
    case "toggle-diff-directory": {
      const collapsed = new Set(state.diffReview.collapsedDirectories);
      if (collapsed.has(action.directory)) {
        collapsed.delete(action.directory);
      } else {
        collapsed.add(action.directory);
      }
      return {
        ...state,
        diffReview: {
          ...state.diffReview,
          collapsedDirectories: [...collapsed],
        },
      };
    }
    case "run-git-review-action": {
      const review = normalizeDiffReview(state.diffReview);
      const actionToRun = review.gitActions.find(
        (gitAction) => gitAction.id === action.actionId,
      );
      if (!actionToRun || actionToRun.status !== "ready") {
        return {
          ...state,
          diffReview: {
            ...review,
            lastAction: actionToRun
              ? `${actionToRun.label} is blocked`
              : "Git action unavailable",
          },
        };
      }
      const now = new Date().toISOString();
      const nextReview = {
        ...review,
        gitActions: review.gitActions.map((gitAction) =>
          gitAction.id === action.actionId
            ? { ...gitAction, lastRunAt: now, status: "done" as const }
            : gitAction,
        ),
        lastAction: `${actionToRun.label} completed locally`,
      };
      return {
        ...state,
        diffReview: normalizeDiffReview(nextReview),
      };
    }
    case "set-diff-file-state": {
      const files = state.diffReview.files.map((file) =>
        file.path === action.path ? { ...file, state: action.state } : file,
      );
      const accepted = files.filter((file) => file.state === "accepted").length;
      const rejected = files.filter((file) => file.state === "rejected").length;
      return {
        ...state,
        diffReview: normalizeDiffReview({
          ...state.diffReview,
          approvalState:
            accepted === files.length
              ? "approved"
              : rejected === files.length
                ? "rejected"
                : accepted > 0 || rejected > 0
                  ? "partially-approved"
                  : "pending",
          files,
          lastAction: action.action,
        }),
      };
    }
    case "set-diff-review-state":
      return {
        ...state,
        diffReview: normalizeDiffReview({
          ...state.diffReview,
          approvalState: action.state,
          files: state.diffReview.files.map((file) => ({
            ...file,
            state:
              action.state === "approved"
                ? "accepted"
                : action.state === "rejected"
                  ? "rejected"
                  : file.state,
          })),
          lastAction: action.action,
        }),
      };
    case "undo-diff-action":
      return {
        ...state,
        diffReview: {
          ...state.diffReview,
          approvalState: "pending",
          gitActions: defaultGitReviewActions(),
          files: state.diffReview.files.map((file) => ({
            ...file,
            state: "pending",
          })),
          lastAction: action.action,
        },
      };
    case "add-diff-comment":
      return {
        ...state,
        diffReview: {
          ...state.diffReview,
          files: state.diffReview.files.map((file) =>
            file.path === action.path
              ? { ...file, comments: file.comments + 1 }
              : file,
          ),
          lastAction: "comment added",
        },
      };
    case "set-browser-url":
      return {
        ...state,
        browserPreview: { ...state.browserPreview, url: action.url },
      };
    case "browser-navigate": {
      const nextHistory = [
        ...state.browserPreview.history.slice(
          0,
          state.browserPreview.historyIndex + 1,
        ),
        action.url,
      ];
      return {
        ...state,
        activeDestination:
          state.activeDestination === "cli" ? "cli" : "browser",
        activePaneTab:
          state.activeDestination === "cli" ? "browser" : state.activePaneTab,
        browserPreview: {
          ...state.browserPreview,
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
          status: action.status ?? "ready",
          url: action.url,
          verificationMessage: "Loaded local preview",
        },
      };
    }
    case "browser-back": {
      const historyIndex = Math.max(0, state.browserPreview.historyIndex - 1);
      return browserHistoryState(state, historyIndex);
    }
    case "browser-forward": {
      const historyIndex = Math.min(
        state.browserPreview.history.length - 1,
        state.browserPreview.historyIndex + 1,
      );
      return browserHistoryState(state, historyIndex);
    }
    case "browser-reload":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          status: "verification-passed",
          verificationMessage: "Reloaded and layout check passed",
        },
      };
    case "browser-device":
      return {
        ...state,
        browserPreview: { ...state.browserPreview, device: action.device },
      };
    case "browser-screenshot":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          screenshotCount: state.browserPreview.screenshotCount + 1,
          verificationMessage: "Screenshot captured locally",
        },
      };
    case "browser-status":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          consoleErrors:
            action.consoleErrors ?? state.browserPreview.consoleErrors,
          status: action.status,
          verificationMessage: action.message,
        },
      };
    case "set-provider-status":
      return {
        ...state,
        providerStatuses: state.providerStatuses.map((provider) =>
          provider.id === action.providerId
            ? { ...provider, connectionStatus: action.status }
            : provider,
        ),
      };
    case "record-provider-health":
      return {
        ...state,
        providerStatuses: state.providerStatuses.map((provider) =>
          provider.id === action.providerId
            ? {
                ...provider,
                connectionStatus: action.status,
                healthCheckedAt: new Date().toISOString(),
                healthOutput: action.output,
                healthSummary: action.summary,
              }
            : provider,
        ),
      };
    case "set-provider-readiness":
      return {
        ...state,
        providerReadiness: {
          checkedAt: new Date().toISOString(),
          message: action.message,
          providerId: action.providerId,
          status: action.status,
        },
      };
    case "set-provider-model":
      return {
        ...state,
        providerStatuses: state.providerStatuses.map((provider) =>
          provider.id === action.providerId
            ? { ...provider, defaultModel: action.model }
            : provider,
        ),
      };
    case "queue-provider-handoff": {
      const session = normalizeProviderSession(action.session);
      const handoff = normalizeProviderHandoff(action.handoff);
      const existingSession = state.providerSessions.some(
        (item) => item.id === session.id,
      );
      return {
        ...state,
        activeDestination: "providers",
        selectedProviderSessionId: session.id,
        providerSessions: existingSession
          ? state.providerSessions.map((item) =>
              item.id === session.id ? session : item,
            )
          : [session, ...state.providerSessions],
        providerHandoffs: [handoff, ...state.providerHandoffs].slice(0, 12),
      };
    }
    case "set-provider-session-status":
      return {
        ...state,
        selectedProviderSessionId: action.sessionId,
        providerSessions: state.providerSessions.map((session) =>
          session.id === action.sessionId
            ? {
                ...session,
                status: action.status,
                lastEvent: action.event,
                updatedAt: new Date().toISOString(),
              }
            : session,
        ),
      };
    case "reconcile-active-turn":
      return {
        ...state,
        activeTurn: action.turn,
        diffReview: {
          ...state.diffReview,
          activeTurnId: action.turn?.id ?? state.diffReview.activeTurnId,
        },
      };
    case "reconcile-active-turn-timeout": {
      const turn = state.activeTurn;
      if (!turn || turn.status === "done" || turn.status === "failed") {
        return state;
      }
      if (turn.status === "waiting" && turn.approvalsPending > 0) {
        return state;
      }
      const updatedAt = new Date(turn.updatedAt).getTime();
      const now = new Date(action.now).getTime();
      if (
        Number.isNaN(updatedAt) ||
        Number.isNaN(now) ||
        now - updatedAt < action.idleMs
      ) {
        return state;
      }
      return {
        ...state,
        activeTurn: {
          ...turn,
          status: "failed",
          lastEvent: "Idle watchdog marked turn stale",
          reconciledAt: action.now,
          updatedAt: action.now,
        },
      };
    }
    case "set-onboarding-step":
      return {
        ...state,
        activeDestination: "onboarding",
        onboarding: { ...state.onboarding, activeStep: action.step },
      };
    case "complete-onboarding-step":
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          activeStep: nextOnboardingStep(action.step),
          completedSteps: state.onboarding.completedSteps.includes(action.step)
            ? state.onboarding.completedSteps
            : [...state.onboarding.completedSteps, action.step],
        },
      };
  }
}

export function createTerminalPane(
  id: string,
  profile: CommandProfile,
  status: TerminalPaneStatus = "restored",
  options: {
    workspaceMode?: WorkbenchMode;
    branch?: string;
    worktreeName?: string;
  } = {},
): TerminalPane {
  const workspaceMode = options.workspaceMode ?? "local";
  return {
    id,
    title: profile.displayName,
    profileId: profile.id,
    command: [profile.command, ...profile.args].filter(Boolean).join(" "),
    output: defaultTerminalOutput(profile.displayName),
    status,
    lastEvent: status === "running" ? "running command" : "restored",
    workspaceMode,
    branch:
      options.branch ??
      (workspaceMode === "worktree" ? "gyro/worktree" : "main"),
    worktreeName: options.worktreeName,
    createdAt: new Date().toISOString(),
  };
}

function normalizeTerminalPane(pane: TerminalPane): TerminalPane {
  const workspaceMode = pane.workspaceMode ?? "local";
  return {
    ...pane,
    workspaceMode,
    branch:
      pane.branch ?? (workspaceMode === "worktree" ? "gyro/worktree" : "main"),
    worktreeName: pane.worktreeName,
  };
}

function normalizeTask(task: Task): Task {
  const workspaceMode = task.workspaceMode ?? "local";
  return {
    ...task,
    workspaceMode,
    branch:
      task.branch ?? (workspaceMode === "worktree" ? "gyro/worktree" : "main"),
    worktreeName: task.worktreeName,
  };
}

function normalizeAutomation(automation: Automation): Automation {
  const workspaceMode = automation.workspaceMode ?? "local";
  return {
    ...automation,
    branch:
      automation.branch ??
      (workspaceMode === "worktree" ? "gyro/worktree" : "main"),
    runHistory: Array.isArray(automation.runHistory)
      ? automation.runHistory
      : [],
    triageState: automation.triageState ?? "none",
    unreadResults: automation.unreadResults ?? 0,
    workspaceMode,
    worktreeName: automation.worktreeName,
  };
}

function normalizeProviderSession(session: ProviderSession): ProviderSession {
  const now = new Date().toISOString();
  return {
    ...session,
    branch: session.branch ?? "main",
    createdAt: session.createdAt ?? now,
    displayName: session.displayName ?? session.providerId,
    lastEvent: session.lastEvent ?? "ready",
    model: session.model ?? "Default",
    sessionTitle: session.sessionTitle ?? "Provider session",
    status: session.status ?? "ready",
    updatedAt: session.updatedAt ?? now,
    workspaceMode: session.workspaceMode ?? "local",
    worktreeName: session.worktreeName,
  };
}

function normalizeProviderHandoff(handoff: ProviderHandoff): ProviderHandoff {
  const now = new Date().toISOString();
  return {
    ...handoff,
    contextSummary: handoff.contextSummary ?? "Current thread context",
    createdAt: handoff.createdAt ?? now,
    fromLabel: handoff.fromLabel ?? handoff.fromProviderId,
    sessionTitle: handoff.sessionTitle ?? "Chat handoff",
    status: handoff.status ?? "queued",
    toLabel: handoff.toLabel ?? handoff.toProviderId,
    updatedAt: handoff.updatedAt ?? now,
  };
}

export function createNotification(
  id: string,
  kind: NotificationKind,
  title: string,
  detail: string,
): Notification {
  return {
    id,
    kind,
    title,
    detail,
    createdAt: new Date().toISOString(),
    read: false,
  };
}

export function defaultCommandProfiles(): CommandProfile[] {
  return [
    {
      id: "shell",
      displayName: "Shell",
      command: "zsh",
      args: ["-l"],
      workingDirectory: "Workspace",
    },
    {
      id: "codex",
      displayName: "Codex",
      command: "codex",
      args: ["--sandbox", "workspace-write"],
      workingDirectory: "Workspace",
    },
    {
      id: "claude",
      displayName: "Claude Code",
      command: "claude",
      args: ["--continue"],
      workingDirectory: "Workspace",
    },
    {
      id: "cursor",
      displayName: "Cursor Agent",
      command: "cursor-agent",
      args: ["run"],
      workingDirectory: "Workspace",
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      command: "gemini",
      args: ["--yolo=false"],
      workingDirectory: "Workspace",
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      command: "opencode",
      args: ["run"],
      workingDirectory: "Workspace",
    },
    {
      id: "custom",
      displayName: "Custom",
      command: "./agent.sh",
      args: [],
      workingDirectory: "Workspace",
    },
  ];
}

export function defaultProviderStatuses(): ProviderStatus[] {
  return [
    {
      id: "openai",
      displayName: "OpenAI / Codex",
      connectionStatus: "not-configured",
      defaultModel: "5.5 Extra High",
      effort: "extra-high",
      allowedTools: ["files", "terminal", "diff", "browser"],
      approvalPolicy: "ask",
    },
    {
      id: "anthropic",
      displayName: "Anthropic / Claude Code",
      connectionStatus: "not-configured",
      defaultModel: "Claude Sonnet",
      effort: "high",
      allowedTools: ["files", "terminal", "diff"],
      approvalPolicy: "ask",
    },
    {
      id: "cursor",
      displayName: "Cursor Agent",
      connectionStatus: "not-configured",
      defaultModel: "Auto",
      effort: "medium",
      allowedTools: ["terminal"],
      approvalPolicy: "ask",
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      connectionStatus: "not-configured",
      defaultModel: "Gemini CLI",
      effort: "medium",
      allowedTools: ["terminal", "browser"],
      approvalPolicy: "ask",
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      connectionStatus: "not-configured",
      defaultModel: "Local default",
      effort: "medium",
      allowedTools: ["terminal"],
      approvalPolicy: "ask",
    },
    {
      id: "custom",
      displayName: "Custom local command",
      connectionStatus: "disconnected",
      defaultModel: "Command profile",
      effort: "low",
      allowedTools: ["terminal"],
      approvalPolicy: "ask",
    },
  ];
}

export function parseProviderHealthOutput(
  providerId: string,
  output: string,
): Pick<ProviderStatus, "connectionStatus" | "healthSummary"> {
  const normalized = output.trim().toLowerCase();
  const providerLabel = providerId === "custom" ? "Custom command" : providerId;

  if (!normalized) {
    return {
      connectionStatus: "disconnected",
      healthSummary: "No health output returned.",
    };
  }

  if (
    /\b(not configured|missing|no api key|no credential|credential missing|unauthenticated|not authenticated|logged out|not logged in|auth required|setup required)\b/.test(
      normalized,
    )
  ) {
    return {
      connectionStatus: "not-configured",
      healthSummary: "Credentials or local login are not configured.",
    };
  }

  if (
    /\b(error|failed|failure|timeout|timed out|unreachable|denied|invalid|crashed|not found)\b/.test(
      normalized,
    )
  ) {
    return {
      connectionStatus: "failed",
      healthSummary: "Health check failed. Inspect the provider setup.",
    };
  }

  if (
    /\b(authenticated|logged in|ready|healthy|ok|connected|verified|available)\b/.test(
      normalized,
    )
  ) {
    return {
      connectionStatus: "connected",
      healthSummary: `${providerLabel} is ready for local handoff.`,
    };
  }

  return {
    connectionStatus: "disconnected",
    healthSummary: "Health output was inconclusive.",
  };
}

function defaultTerminalPanes(): TerminalPane[] {
  return [];
}

function defaultTasks(): Task[] {
  return [];
}

function defaultAutomations(): Automation[] {
  return [];
}

function nextAutomationRunAt() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function defaultDiffReview() {
  return {
    files: [],
    selectedPath: "",
    approvalState: "pending" as const,
    commitMessage: "",
    collapsedDirectories: [],
    gitActions: defaultGitReviewActions(),
    lastAction: "No changes proposed",
  };
}

function normalizeDiffReview(
  diffReview: WorkbenchState["diffReview"],
): WorkbenchState["diffReview"] {
  const normalized = {
    ...diffReview,
    collapsedDirectories: Array.isArray(diffReview.collapsedDirectories)
      ? diffReview.collapsedDirectories
      : [],
    gitActions: Array.isArray(diffReview.gitActions)
      ? diffReview.gitActions
      : defaultGitReviewActions(),
  };
  return {
    ...normalized,
    gitActions: normalizeGitReviewActions(normalized),
  };
}

function defaultGitReviewActions(): GitReviewAction[] {
  return [
    {
      id: "create-branch",
      label: "Create branch",
      detail: "Prepare an isolated review branch",
      status: "ready",
    },
    {
      id: "commit",
      label: "Commit",
      detail: "Commit approved files",
      status: "blocked",
    },
    {
      id: "push",
      label: "Push",
      detail: "Publish the branch",
      status: "blocked",
    },
    {
      id: "open-pr",
      label: "Open PR",
      detail: "Create a pull request",
      status: "blocked",
    },
  ];
}

function normalizeGitReviewActions(
  diffReview: Pick<
    WorkbenchState["diffReview"],
    "approvalState" | "gitActions"
  >,
): GitReviewAction[] {
  const existing = new Map(
    diffReview.gitActions.map((action) => [action.id, action]),
  );
  const actions: GitReviewAction[] = defaultGitReviewActions().map(
    (action) => ({
      ...action,
      ...existing.get(action.id),
    }),
  );
  const createBranchDone =
    actions.find((action) => action.id === "create-branch")?.status === "done";
  const commitDone =
    actions.find((action) => action.id === "commit")?.status === "done";
  const pushDone =
    actions.find((action) => action.id === "push")?.status === "done";
  const approved = diffReview.approvalState === "approved";

  return actions.map((action) => {
    if (action.status === "done" || action.status === "failed") {
      return action;
    }
    if (action.id === "create-branch") {
      return { ...action, status: "ready" as const };
    }
    if (action.id === "commit") {
      return {
        ...action,
        status: approved && createBranchDone ? "ready" : "blocked",
      };
    }
    if (action.id === "push") {
      return { ...action, status: commitDone ? "ready" : "blocked" };
    }
    return { ...action, status: pushDone ? "ready" : "blocked" };
  });
}

function expandedParentDirectories(collapsed: string[], filePath: string) {
  const parentDirectories = new Set(parentDirectoriesForPath(filePath));
  return collapsed.filter((directory) => !parentDirectories.has(directory));
}

function parentDirectoriesForPath(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}

function defaultBrowserPreview() {
  return {
    url: "http://localhost:1420",
    history: ["http://localhost:1420"],
    historyIndex: 0,
    device: "desktop" as const,
    consoleErrors: 0,
    screenshotCount: 0,
    status: "idle" as const,
    verificationMessage: "No preview loaded",
  };
}

function defaultNotifications(): Notification[] {
  return [];
}

function defaultProviderReadiness() {
  return {
    status: "idle" as const,
    message: "Provider readiness has not been checked yet",
  };
}

function browserHistoryState(
  state: WorkbenchState,
  historyIndex: number,
): WorkbenchState {
  const url =
    state.browserPreview.history[historyIndex] ?? state.browserPreview.url;

  return {
    ...state,
    browserPreview: {
      ...state.browserPreview,
      historyIndex,
      status: "ready",
      url,
      verificationMessage: "History navigation ready",
    },
  };
}

function nextOnboardingStep(step: OnboardingStepId): OnboardingStepId {
  const order: OnboardingStepId[] = [
    "welcome",
    "theme",
    "workspace",
    "provider",
    "approval",
    "first-session",
  ];
  const index = order.indexOf(step);
  return order[Math.min(index + 1, order.length - 1)] ?? "welcome";
}

function defaultTerminalOutput(profileName?: string) {
  return `Gyro ${profileName ?? "Shell"}\n~/Documents/Gyro\n\n$ gyro doctor\nworkspace store ready\nCLI attach socket ready\napprovals required\n\n$ gyro run "inspect this repo"\nWorking locally. Command execution will require approval.`;
}
