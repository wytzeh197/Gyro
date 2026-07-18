import type {
  AppDestination,
  Automation,
  AutomationStatus,
  AutomationTriageState,
  BrowserPreview,
  BrowserPreviewDevice,
  BrowserPreviewStatus,
  ChatSidePanelId,
  CliLaunchPreset,
  CommandProfile,
  DiffApprovalState,
  DiffFileState,
  DiffSource,
  DebugSessionState,
  EditorBuffer,
  EditorGroup,
  EditorSelection,
  EditorTab,
  IdeAiToolCall,
  IdeAssistantRequest,
  IdeCommand,
  IdeContribution,
  IdeViewId,
  LanguageServerState,
  OutputChannel,
  ProblemDiagnostic,
  SourceControlState,
  TaskDefinition,
  TestTreeItem,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
  GitReviewAction,
  GitReviewActionId,
  Notification,
  NotificationKind,
  OnboardingStepId,
  ProviderConnectionStatus,
  ProviderHealthDetails,
  ProviderHandoff,
  ProviderId,
  ProviderSession,
  ProviderSessionStatus,
  ProviderStatus,
  ProviderReadinessStatus,
  SettingsSectionId,
  SessionsLayoutId,
  SurfaceId,
  Task,
  TaskStatus,
  TerminalPane,
  TerminalPaneLayout,
  TerminalPaneStatus,
  TerminalTemplate,
  ThemeMode,
  WorkbenchDensity,
  WorkbenchMode,
  WorkbenchPaneTab,
  WorkbenchState,
  WorkbenchPreferences,
  WorkbenchTurn,
  WorkspaceLayoutId,
} from "./types";
import { defaultProviderStatuses as catalogDefaultProviderStatuses } from "./provider-catalog.ts";

export const CLI_LAUNCH_PRESET_MAX_PANES = 8;
const MAX_RESTORED_EDITOR_TABS = 100;
const MAX_RESTORED_EDITOR_GROUPS = 8;

function createEditorGroup(
  id: string,
  title: string,
  activePath?: string,
): EditorGroup {
  const tabs =
    activePath !== undefined
      ? [
          {
            path: activePath,
            title: workspaceNameFromPath(activePath),
            dirty: false,
          },
        ]
      : [];
  return {
    id,
    title,
    activePath,
    tabs,
    panes: [{ id: `${id}-pane`, path: activePath }],
  };
}

function defaultIdeLayout(): WorkbenchState["ide"]["layout"] {
  return {
    groups: [createEditorGroup("group-main", "Main")],
    activeGroupId: "group-main",
    splitDirection: "right",
    minimapEnabled: true,
    restoreOnLaunch: true,
    rightAssistantOpen: true,
  };
}

export function sanitizeStoredIdeState(
  value: unknown,
  base: WorkbenchState["ide"],
): WorkbenchState["ide"] {
  const ide = storedRecord(value);
  if (!ide) {
    return base;
  }
  const storedLayout = storedRecord(ide.layout);
  const restoreOnLaunch = storedBoolean(
    storedLayout?.restoreOnLaunch,
    base.layout.restoreOnLaunch,
  );
  const layoutPreferences = {
    splitDirection:
      storedLayout?.splitDirection === "down" ||
      storedLayout?.splitDirection === "right"
        ? storedLayout.splitDirection
        : base.layout.splitDirection,
    minimapEnabled: storedBoolean(
      storedLayout?.minimapEnabled,
      base.layout.minimapEnabled,
    ),
    restoreOnLaunch,
    rightAssistantOpen: storedBoolean(
      storedLayout?.rightAssistantOpen,
      base.layout.rightAssistantOpen,
    ),
  };
  const activeView = isIdeViewId(ide.activeView)
    ? ide.activeView
    : base.activeView;

  if (!restoreOnLaunch) {
    return {
      ...base,
      activePath: undefined,
      activeView,
      tabs: [],
      layout: {
        ...base.layout,
        ...layoutPreferences,
        groups: [createEditorGroup("group-main", "Main")],
        activeGroupId: "group-main",
      },
    };
  }

  const tabs: EditorTab[] = [];
  const seenPaths = new Set<string>();
  const rawTabs = Array.isArray(ide.tabs) ? ide.tabs : [];
  for (const rawTab of rawTabs.slice(0, MAX_RESTORED_EDITOR_TABS)) {
    const tab = storedRecord(rawTab);
    const path = storedRelativeEditorPath(tab?.path);
    if (!path || seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    const storedTitle =
      typeof tab?.title === "string" ? tab.title.trim().slice(0, 256) : "";
    tabs.push({
      path,
      title: storedTitle || workspaceNameFromPath(path),
      dirty: false,
      pinned: tab?.pinned === true,
      preview: false,
      groupId:
        typeof tab?.groupId === "string" && storedEditorGroupId(tab.groupId)
          ? tab.groupId
          : undefined,
    });
  }
  const tabByPath = new Map(tabs.map((tab) => [tab.path, tab]));
  const seenGroupIds = new Set<string>();
  const rawGroups = Array.isArray(storedLayout?.groups)
    ? storedLayout.groups
    : [];
  let groups: EditorGroup[] = [];
  for (const rawGroup of rawGroups.slice(0, MAX_RESTORED_EDITOR_GROUPS)) {
    const group = storedRecord(rawGroup);
    const id = storedEditorGroupId(group?.id);
    if (!id || seenGroupIds.has(id)) {
      continue;
    }
    seenGroupIds.add(id);
    const groupTabs: EditorTab[] = [];
    const groupPaths = new Set<string>();
    const rawGroupTabs = Array.isArray(group?.tabs) ? group.tabs : [];
    for (const rawGroupTab of rawGroupTabs) {
      const path = storedRelativeEditorPath(storedRecord(rawGroupTab)?.path);
      const tab = path ? tabByPath.get(path) : undefined;
      if (!tab || groupPaths.has(tab.path)) {
        continue;
      }
      groupPaths.add(tab.path);
      groupTabs.push({ ...tab, groupId: id });
    }
    const requestedActivePath = storedRelativeEditorPath(group?.activePath);
    const activePath = groupTabs.some((tab) => tab.path === requestedActivePath)
      ? requestedActivePath
      : groupTabs[0]?.path;
    const storedTitle =
      typeof group?.title === "string" ? group.title.trim().slice(0, 80) : "";
    groups.push({
      id,
      title: storedTitle || `Group ${groups.length + 1}`,
      activePath,
      tabs: groupTabs,
      panes: [{ id: `${id}-pane`, path: activePath }],
    });
  }

  if (groups.length === 0) {
    groups = [
      {
        ...createEditorGroup("group-main", "Main"),
        activePath: tabs[0]?.path,
        tabs: tabs.map((tab) => ({ ...tab, groupId: "group-main" })),
        panes: [{ id: "group-main-pane", path: tabs[0]?.path }],
      },
    ];
  } else {
    const representedPaths = new Set(
      groups.flatMap((group) => group.tabs.map((tab) => tab.path)),
    );
    const unassignedTabs = tabs.filter(
      (tab) => !representedPaths.has(tab.path),
    );
    if (unassignedTabs.length > 0) {
      const firstGroup = groups[0];
      if (firstGroup) {
        const firstTabs = [
          ...firstGroup.tabs,
          ...unassignedTabs.map((tab) => ({
            ...tab,
            groupId: firstGroup.id,
          })),
        ];
        groups = [
          {
            ...firstGroup,
            activePath: firstGroup.activePath ?? firstTabs[0]?.path,
            tabs: firstTabs,
            panes: [
              {
                id: `${firstGroup.id}-pane`,
                path: firstGroup.activePath ?? firstTabs[0]?.path,
              },
            ],
          },
          ...groups.slice(1),
        ];
      }
    }
  }

  const requestedGroupId = storedEditorGroupId(storedLayout?.activeGroupId);
  let activeGroupId = groups.some((group) => group.id === requestedGroupId)
    ? requestedGroupId
    : groups[0]?.id;
  const requestedActivePath = storedRelativeEditorPath(ide.activePath);
  let activePath = requestedActivePath
    ? tabByPath.get(requestedActivePath)?.path
    : undefined;
  if (activePath) {
    const requestedGroup = groups.find((group) => group.id === activeGroupId);
    const containingGroup = requestedGroup?.tabs.some(
      (tab) => tab.path === activePath,
    )
      ? requestedGroup
      : groups.find((group) =>
          group.tabs.some((tab) => tab.path === activePath),
        );
    if (containingGroup) {
      activeGroupId = containingGroup.id;
    }
  } else {
    activePath =
      groups.find((group) => group.id === activeGroupId)?.activePath ??
      tabs[0]?.path;
  }
  activeGroupId = activeGroupId ?? "group-main";
  const restoredTabs = tabs.map((tab) => {
    const requestedGroup = groups.find(
      (group) =>
        group.id === tab.groupId &&
        group.tabs.some((groupTab) => groupTab.path === tab.path),
    );
    const ownerGroup =
      requestedGroup ??
      groups.find((group) =>
        group.tabs.some((groupTab) => groupTab.path === tab.path),
      );
    return { ...tab, groupId: ownerGroup?.id };
  });

  return {
    ...base,
    activePath,
    activeView,
    tabs: restoredTabs,
    layout: {
      ...base.layout,
      ...layoutPreferences,
      groups,
      activeGroupId,
    },
  };
}

function storedRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function storedBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function storedRelativeEditorPath(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const path = value.trim().replaceAll("\\", "/");
  if (
    !path ||
    path.length > 4_096 ||
    path.startsWith("/") ||
    /^[a-z]:\//i.test(path) ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  return path;
}

function storedEditorGroupId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
    ? value
    : undefined;
}

function isIdeViewId(value: unknown): value is IdeViewId {
  return (
    value === "explorer" ||
    value === "search" ||
    value === "source-control" ||
    value === "run-test" ||
    value === "ai" ||
    value === "settings"
  );
}

function defaultSourceControlState(): SourceControlState {
  return {
    provider: "git",
    available: false,
    ahead: 0,
    behind: 0,
    additions: 0,
    deletions: 0,
    statsPartial: false,
    files: [],
  };
}

function defaultOutputChannels(): OutputChannel[] {
  return [
    {
      id: "system",
      label: "System",
      kind: "system",
      lines: [],
    },
  ];
}

function defaultIdeContributions(): IdeContribution[] {
  const commands: IdeCommand[] = [
    {
      id: "workbench.files.open",
      label: "Open file",
      category: "file",
      viewId: "explorer",
    },
    {
      id: "workbench.files.search",
      label: "Search workspace",
      category: "view",
      viewId: "search",
    },
    {
      id: "workbench.scm.refresh",
      label: "Refresh source control",
      category: "source-control",
      viewId: "source-control",
    },
    {
      id: "workbench.tasks.run",
      label: "Run task",
      category: "run",
      viewId: "run-test",
    },
    {
      id: "workbench.ai.askEditor",
      label: "Ask about editor context",
      category: "ai",
      viewId: "ai",
    },
  ];
  return [
    {
      id: "gyro-core-ide",
      label: "Gyro Core Workspace",
      views: [
        "explorer",
        "search",
        "source-control",
        "run-test",
        "ai",
        "settings",
      ],
      commands,
    },
  ];
}

function syncEditorGroupsForActivePath(
  layout: WorkbenchState["ide"]["layout"],
  path?: string,
): WorkbenchState["ide"]["layout"] {
  if (!path) {
    return layout;
  }
  const groups =
    layout.groups.length > 0 ? layout.groups : defaultIdeLayout().groups;
  const fallbackGroup = groups[0] ?? createEditorGroup("group-main", "Main");
  const activeGroupId = layout.activeGroupId || fallbackGroup.id;
  return {
    ...layout,
    activeGroupId,
    groups: groups.map((group, index) => {
      if (group.id !== activeGroupId && !(index === 0 && !activeGroupId)) {
        return group;
      }
      const hasTab = group.tabs.some((tab) => tab.path === path);
      const tabs = hasTab
        ? group.tabs
        : [
            ...group.tabs,
            { path, title: workspaceNameFromPath(path), dirty: false },
          ];
      return {
        ...group,
        activePath: path,
        panes:
          group.panes.length > 0 ? group.panes : [{ id: `${group.id}-pane` }],
        tabs,
      };
    }),
  };
}

function upsertPathInActiveEditorGroup(
  layout: WorkbenchState["ide"]["layout"],
  path: string,
): WorkbenchState["ide"]["layout"] {
  return syncEditorGroupsForActivePath(layout, path);
}

function syncEditorTabInLayout(
  layout: WorkbenchState["ide"]["layout"],
  tab: EditorTab,
): WorkbenchState["ide"]["layout"] {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((groupTab) =>
        groupTab.path === tab.path ? { ...groupTab, ...tab } : groupTab,
      ),
    })),
  };
}

function updateEditorTabInLayout(
  layout: WorkbenchState["ide"]["layout"],
  path: string,
  updates: Partial<EditorTab>,
): WorkbenchState["ide"]["layout"] {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.path === path ? { ...tab, ...updates } : tab,
      ),
    })),
  };
}

function removeEditorTabFromLayout(
  layout: WorkbenchState["ide"]["layout"],
  path: string,
): WorkbenchState["ide"]["layout"] {
  return {
    ...layout,
    groups: layout.groups.map((group) => {
      const tabs = group.tabs.filter((tab) => tab.path !== path);
      const activePath =
        group.activePath === path
          ? tabs[tabs.length - 1]?.path
          : group.activePath;
      return {
        ...group,
        activePath,
        tabs,
        panes: group.panes.map((pane) =>
          pane.path === path ? { ...pane, path: activePath } : pane,
        ),
      };
    }),
  };
}

function editorPathMatches(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

function renameEditorPath(path: string, fromPath: string, toPath: string) {
  return editorPathMatches(path, fromPath)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

function moveTabToEditorGroup(
  layout: WorkbenchState["ide"]["layout"],
  path: string,
  toGroupId: string,
  fromGroupId?: string,
): WorkbenchState["ide"]["layout"] {
  if (!layout.groups.some((group) => group.id === toGroupId)) {
    return layout;
  }
  let movedTab: EditorTab | undefined;
  const groupsWithoutTab = layout.groups.map((group) => {
    if (fromGroupId && group.id !== fromGroupId) {
      return group;
    }
    const tab = group.tabs.find((item) => item.path === path);
    if (tab) {
      movedTab = { ...tab, groupId: toGroupId };
    }
    return {
      ...group,
      tabs: group.tabs.filter((item) => item.path !== path),
      activePath: group.activePath === path ? undefined : group.activePath,
    };
  });
  if (!movedTab) {
    movedTab = {
      path,
      title: workspaceNameFromPath(path),
      dirty: false,
      groupId: toGroupId,
    };
  }
  const tabToMove = movedTab;
  return {
    ...layout,
    activeGroupId: toGroupId,
    groups: groupsWithoutTab.map((group) =>
      group.id === toGroupId
        ? {
            ...group,
            activePath: path,
            tabs: group.tabs.some((tab) => tab.path === path)
              ? group.tabs
              : [...group.tabs, tabToMove],
            panes:
              group.panes.length > 0
                ? group.panes
                : [{ id: `${group.id}-pane` }],
          }
        : group,
    ),
  };
}

function nextEditorGroupId(layout: WorkbenchState["ide"]["layout"]) {
  let index = layout.groups.length + 1;
  while (layout.groups.some((group) => group.id === `group-${index}`)) {
    index += 1;
  }
  return `group-${index}`;
}

function decorationsFromSourceControl(
  sourceControl: SourceControlState,
): WorkbenchState["ide"]["fileDecorations"] {
  return sourceControl.files.map((file) => ({
    path: file.path,
    badge:
      file.state === "modified"
        ? "M"
        : file.state === "added" || file.state === "untracked"
          ? "A"
          : file.state === "deleted"
            ? "D"
            : file.state === "renamed"
              ? "R"
              : file.state === "conflicted"
                ? "!"
                : "S",
    color:
      file.state === "modified"
        ? "modified"
        : file.state === "added" || file.state === "untracked"
          ? "added"
          : file.state === "deleted"
            ? "deleted"
            : file.state === "conflicted"
              ? "warning"
              : "modified",
    tooltip: file.staged ? `${file.state}, staged` : file.state,
  }));
}

function upsertOutputChannel(
  channels: OutputChannel[],
  channel: OutputChannel,
): OutputChannel[] {
  return channels.some((item) => item.id === channel.id)
    ? channels.map((item) => (item.id === channel.id ? channel : item))
    : [...channels, channel];
}

function appendOutputLines(
  channels: OutputChannel[],
  channelId: string,
  lines: string[],
): OutputChannel[] {
  const updatedAt = new Date().toISOString();
  if (!channels.some((channel) => channel.id === channelId)) {
    return [
      ...channels,
      {
        id: channelId,
        label: channelId,
        kind: "system",
        lines,
        updatedAt,
      },
    ];
  }
  return channels.map((channel) =>
    channel.id === channelId
      ? { ...channel, lines: [...channel.lines, ...lines], updatedAt }
      : channel,
  );
}

export type WorkbenchAction =
  | { type: "reset-state"; state?: WorkbenchState }
  | { type: "select-destination"; destination: AppDestination }
  | { type: "select-surface"; surface: SurfaceId }
  | { type: "select-sessions" }
  | { type: "select-workspace-layout"; layout: WorkspaceLayoutId }
  | { type: "set-pane-tab"; tab: WorkbenchPaneTab }
  | { type: "open-tool-panel"; tab?: WorkbenchPaneTab }
  | { type: "close-tool-panel" }
  | { type: "set-workbench-mode"; mode: WorkbenchMode }
  | { type: "set-theme"; theme: ThemeMode }
  | { type: "set-density"; density: WorkbenchDensity }
  | { type: "set-settings-section"; section: SettingsSectionId }
  | { type: "set-usage-provider"; providerId?: ProviderId }
  | { type: "set-usage-visualization"; visualization: "bars" | "wheels" }
  | { type: "set-cli-launch-preset"; preset: CliLaunchPreset }
  | { type: "toggle-sidebar-chats" }
  | { type: "toggle-chat-environment-rail" }
  | { type: "set-chat-environment-rail"; open: boolean }
  | { type: "toggle-chat-plan" }
  | { type: "set-chat-panel"; panel?: ChatSidePanelId }
  | { type: "ide-open-tab"; tab: EditorTab }
  | { type: "ide-close-tab"; path: string; groupId?: string }
  | { type: "ide-rename-path"; fromPath: string; toPath: string }
  | { type: "ide-delete-path"; path: string }
  | { type: "ide-pin-tab"; path: string }
  | { type: "ide-select-tab"; path: string }
  | { type: "ide-select-group"; groupId: string }
  | { type: "ide-split-group"; direction: "right" | "down" }
  | { type: "ide-close-group"; groupId: string }
  | {
      type: "ide-move-tab";
      path: string;
      toGroupId: string;
      fromGroupId?: string;
    }
  | { type: "ide-select-view"; view: IdeViewId }
  | { type: "ide-toggle-minimap" }
  | { type: "ide-toggle-assistant" }
  | { type: "ide-upsert-buffer"; buffer: EditorBuffer }
  | { type: "ide-update-buffer"; path: string; content: string }
  | {
      type: "ide-mark-buffer-saved";
      path: string;
      content: string;
      contentHash?: string;
      sizeBytes: number;
    }
  | { type: "ide-mark-buffer-error"; path: string; error: string }
  | { type: "ide-set-selection"; selection?: EditorSelection }
  | { type: "ide-record-assistant-request"; request: IdeAssistantRequest }
  | { type: "ide-set-search-query"; query: WorkspaceSearchQuery }
  | {
      type: "ide-set-search-results";
      query: WorkspaceSearchQuery;
      results: WorkspaceSearchResult[];
    }
  | { type: "ide-set-diagnostics"; diagnostics: ProblemDiagnostic[] }
  | { type: "ide-set-source-control"; sourceControl: SourceControlState }
  | { type: "ide-set-tasks"; tasks: TaskDefinition[] }
  | { type: "ide-set-test-tree"; tests: TestTreeItem[] }
  | { type: "ide-set-debug-session"; session: DebugSessionState }
  | { type: "ide-remove-debug-session"; sessionId: string }
  | { type: "ide-set-language-server"; server: LanguageServerState }
  | { type: "ide-remove-language-server"; serverId: string }
  | { type: "ide-upsert-output-channel"; channel: OutputChannel }
  | { type: "ide-append-output"; channelId: string; lines: string[] }
  | { type: "ide-select-output-channel"; channelId: string }
  | { type: "ide-register-contribution"; contribution: IdeContribution }
  | { type: "ide-record-ai-tool-call"; toolCall: IdeAiToolCall }
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
      projectPath?: string;
      workingDirectory?: string;
    }
  | {
      type: "set-terminal-pane-attention";
      paneId: string;
      attention?: "waiting" | "failed";
    }
  | {
      type: "upsert-restored-terminal-pane";
      pane: TerminalPane;
    }
  | {
      type: "move-terminal-pane";
      sourcePaneId: string;
      targetPaneId: string;
    }
  | {
      type: "set-terminal-pane-layout";
      paneId: string;
      layout: TerminalPaneLayout;
    }
  | { type: "remove-terminal-pane"; paneId: string }
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
  | { type: "browser-capture-start" }
  | {
      type: "browser-capture-success";
      capture: NonNullable<BrowserPreview["latestCapture"]>;
    }
  | { type: "browser-capture-failure"; error: string }
  | {
      type: "browser-status";
      status: BrowserPreviewStatus;
      message: string;
      consoleErrors?: number;
      diagnostics?: BrowserPreview["diagnostics"];
      diagnosticsSupported?: boolean;
      diagnosticsCaptured?: boolean;
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
      details?: ProviderHealthDetails;
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
  const ideDefaults: WorkbenchState["ide"] = {
    tabs: [],
    activePath: undefined,
    buffers: {},
    selection: undefined,
    lastAssistantRequest: undefined,
    activeView: "explorer",
    layout: defaultIdeLayout(),
    searchQuery: { query: "", maxResults: 200 },
    searchResults: [],
    fileDecorations: [],
    diagnostics: [],
    sourceControl: defaultSourceControlState(),
    taskDefinitions: [],
    testTree: [],
    debugSessions: [],
    languageServers: [],
    outputChannels: defaultOutputChannels(),
    activeOutputChannelId: "system",
    contributions: defaultIdeContributions(),
    aiToolCalls: [],
  };

  return {
    activeDestination: "workspace",
    activeWorkspaceLayout: "thread",
    lastSessionsLayout: "thread",
    activePaneTab: "diff",
    isToolPanelOpen: false,
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
      activeStep: "account",
      completedSteps: [],
    },
    ...overrides,
    ide: {
      ...ideDefaults,
      ...overrides.ide,
      layout: {
        ...ideDefaults.layout,
        ...overrides.ide?.layout,
        groups: overrides.ide?.layout?.groups ?? ideDefaults.layout.groups,
      },
      languageServers: overrides.ide?.languageServers ?? [],
    },
    preferences: normalizeWorkbenchPreferences(overrides.preferences),
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
    case "select-surface": {
      const layout = workspaceLayoutForLegacySurface(action.surface);
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: layout,
        lastSessionsLayout: isSessionsLayout(layout)
          ? layout
          : state.lastSessionsLayout,
        activePaneTab:
          layout === "terminal-grid" ? "terminal" : state.activePaneTab,
        isToolPanelOpen:
          layout === "terminal-grid"
            ? true
            : layout === "thread"
              ? false
              : state.isToolPanelOpen,
      };
    }
    case "select-sessions":
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: state.lastSessionsLayout,
        activePaneTab:
          state.lastSessionsLayout === "terminal-grid"
            ? "terminal"
            : state.activePaneTab,
        isToolPanelOpen: state.lastSessionsLayout === "terminal-grid",
      };
    case "select-workspace-layout":
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: action.layout,
        lastSessionsLayout: isSessionsLayout(action.layout)
          ? action.layout
          : state.lastSessionsLayout,
        activePaneTab:
          action.layout === "terminal-grid" ? "terminal" : state.activePaneTab,
        isToolPanelOpen:
          action.layout === "terminal-grid"
            ? true
            : action.layout === "thread"
              ? false
              : state.isToolPanelOpen,
      };
    case "set-pane-tab":
      return { ...state, activePaneTab: action.tab };
    case "open-tool-panel":
      return {
        ...state,
        activeDestination: "workspace",
        activePaneTab: action.tab ?? state.activePaneTab,
        isToolPanelOpen: true,
      };
    case "close-tool-panel":
      return { ...state, isToolPanelOpen: false };
    case "set-workbench-mode":
      return {
        ...state,
        workspaceMode: action.mode,
        isToolPanelOpen:
          state.activeWorkspaceLayout === "thread"
            ? false
            : state.isToolPanelOpen,
      };
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
    case "set-usage-provider":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          usageProviderId: action.providerId,
        },
      };
    case "set-usage-visualization":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          usageVisualization: action.visualization,
        },
      };
    case "set-cli-launch-preset":
      return {
        ...state,
        preferences: {
          ...state.preferences,
          cliLaunchPreset: normalizeCliLaunchPreset(action.preset),
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
      return chatPanelState(
        state,
        state.preferences.activeChatPanel ? undefined : "environment",
      );
    case "set-chat-environment-rail":
      return chatPanelState(state, action.open ? "environment" : undefined);
    case "toggle-chat-plan":
      return chatPanelState(
        state,
        state.preferences.activeChatPanel === "plan" ? "environment" : "plan",
      );
    case "set-chat-panel":
      return chatPanelState(state, action.panel);
    case "ide-open-tab": {
      const existingTab = state.ide.tabs.find(
        (item) => item.path === action.tab.path,
      );
      const tab = normalizeEditorTab({
        ...existingTab,
        ...action.tab,
        dirty: existingTab?.dirty ?? action.tab.dirty,
        pinned: existingTab?.pinned || action.tab.pinned,
        preview: existingTab?.pinned ? false : action.tab.preview,
      });
      const activeGroup = state.ide.layout.groups.find(
        (group) => group.id === state.ide.layout.activeGroupId,
      );
      const previewPath =
        tab.preview && !tab.pinned
          ? activeGroup?.tabs.find(
              (item) =>
                item.path !== tab.path &&
                item.preview &&
                !item.pinned &&
                !item.dirty,
            )?.path
          : undefined;
      const baseTabs = previewPath
        ? state.ide.tabs.filter((item) => item.path !== previewPath)
        : state.ide.tabs;
      const tabs = baseTabs.some((item) => item.path === tab.path)
        ? baseTabs.map((item) =>
            item.path === tab.path ? { ...item, ...tab } : item,
          )
        : [...baseTabs, tab];
      const baseLayout = previewPath
        ? removeEditorTabFromLayout(state.ide.layout, previewPath)
        : state.ide.layout;
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: "code",
        ide: {
          ...state.ide,
          tabs,
          activePath: tab.path,
          layout: syncEditorTabInLayout(
            upsertPathInActiveEditorGroup(baseLayout, tab.path),
            tab,
          ),
        },
      };
    }
    case "ide-pin-tab": {
      const existingTab = state.ide.tabs.find(
        (tab) => tab.path === action.path,
      );
      if (!existingTab) {
        return state;
      }
      const updates = { pinned: true, preview: false };
      return {
        ...state,
        ide: {
          ...state.ide,
          tabs: state.ide.tabs.map((tab) =>
            tab.path === action.path ? { ...tab, ...updates } : tab,
          ),
          layout: updateEditorTabInLayout(
            state.ide.layout,
            action.path,
            updates,
          ),
        },
      };
    }
    case "ide-rename-path": {
      if (
        !action.fromPath ||
        !action.toPath ||
        action.fromPath === action.toPath
      ) {
        return state;
      }
      const remap = (path: string) =>
        renameEditorPath(path, action.fromPath, action.toPath);
      const tabs = state.ide.tabs.map((tab) => {
        const path = remap(tab.path);
        return path === tab.path
          ? tab
          : { ...tab, path, title: workspaceNameFromPath(path) };
      });
      const buffers = Object.fromEntries(
        Object.entries(state.ide.buffers).map(([path, buffer]) => {
          const nextPath = remap(path);
          return [nextPath, { ...buffer, path: nextPath }];
        }),
      );
      const groups = state.ide.layout.groups.map((group) => ({
        ...group,
        activePath: group.activePath ? remap(group.activePath) : undefined,
        tabs: group.tabs.map((tab) => {
          const path = remap(tab.path);
          return path === tab.path
            ? tab
            : { ...tab, path, title: workspaceNameFromPath(path) };
        }),
        panes: group.panes.map((pane) => ({
          ...pane,
          path: pane.path ? remap(pane.path) : undefined,
        })),
      }));
      const selection = state.ide.selection
        ? { ...state.ide.selection, path: remap(state.ide.selection.path) }
        : undefined;
      const lastAssistantRequest = state.ide.lastAssistantRequest
        ? {
            ...state.ide.lastAssistantRequest,
            path: state.ide.lastAssistantRequest.path
              ? remap(state.ide.lastAssistantRequest.path)
              : undefined,
            selection: state.ide.lastAssistantRequest.selection
              ? {
                  ...state.ide.lastAssistantRequest.selection,
                  path: remap(state.ide.lastAssistantRequest.selection.path),
                }
              : undefined,
            visibleTabs: state.ide.lastAssistantRequest.visibleTabs.map(remap),
          }
        : undefined;
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath: state.ide.activePath
            ? remap(state.ide.activePath)
            : undefined,
          buffers,
          diagnostics: state.ide.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            path: remap(diagnostic.path),
          })),
          fileDecorations: state.ide.fileDecorations.map((decoration) => ({
            ...decoration,
            path: remap(decoration.path),
          })),
          languageServers: state.ide.languageServers.map((server) => ({
            ...server,
            activePath: server.activePath
              ? remap(server.activePath)
              : undefined,
          })),
          lastAssistantRequest,
          searchResults: state.ide.searchResults.map((result) => ({
            ...result,
            path: remap(result.path),
          })),
          selection,
          tabs,
          layout: { ...state.ide.layout, groups },
        },
      };
    }
    case "ide-delete-path": {
      if (!action.path) {
        return state;
      }
      const keepPath = (path: string) => !editorPathMatches(path, action.path);
      const groups = state.ide.layout.groups.map((group) => {
        const tabs = group.tabs.filter((tab) => keepPath(tab.path));
        const activePath =
          group.activePath && keepPath(group.activePath)
            ? group.activePath
            : tabs.at(-1)?.path;
        return {
          ...group,
          activePath,
          tabs,
          panes: group.panes.map((pane) => ({
            ...pane,
            path: pane.path && keepPath(pane.path) ? pane.path : activePath,
          })),
        };
      });
      let activeGroupId = state.ide.layout.activeGroupId;
      let activePath = groups.find(
        (group) => group.id === activeGroupId,
      )?.activePath;
      if (!activePath) {
        const populatedGroup = groups.find((group) => group.activePath);
        if (populatedGroup) {
          activeGroupId = populatedGroup.id;
          activePath = populatedGroup.activePath;
        }
      }
      const tabs = state.ide.tabs.filter((tab) => keepPath(tab.path));
      const buffers = Object.fromEntries(
        Object.entries(state.ide.buffers).filter(([path]) => keepPath(path)),
      );
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath,
          buffers,
          diagnostics: state.ide.diagnostics.filter((diagnostic) =>
            keepPath(diagnostic.path),
          ),
          fileDecorations: state.ide.fileDecorations.filter((decoration) =>
            keepPath(decoration.path),
          ),
          languageServers: state.ide.languageServers.filter(
            (server) => !server.activePath || keepPath(server.activePath),
          ),
          lastAssistantRequest:
            state.ide.lastAssistantRequest?.path &&
            !keepPath(state.ide.lastAssistantRequest.path)
              ? undefined
              : state.ide.lastAssistantRequest,
          searchResults: state.ide.searchResults.filter((result) =>
            keepPath(result.path),
          ),
          selection:
            state.ide.selection && keepPath(state.ide.selection.path)
              ? state.ide.selection
              : undefined,
          tabs,
          layout: { ...state.ide.layout, activeGroupId, groups },
        },
      };
    }
    case "ide-close-tab": {
      if (
        action.groupId &&
        !state.ide.layout.groups.some((group) => group.id === action.groupId)
      ) {
        return state;
      }
      const groups = state.ide.layout.groups.map((group) => {
        if (action.groupId && group.id !== action.groupId) {
          return group;
        }
        const groupTabs = group.tabs.filter((tab) => tab.path !== action.path);
        const activePath =
          group.activePath === action.path
            ? groupTabs[groupTabs.length - 1]?.path
            : group.activePath;
        return {
          ...group,
          activePath,
          tabs: groupTabs,
          panes: group.panes.map((pane) =>
            pane.path === action.path ? { ...pane, path: activePath } : pane,
          ),
        };
      });
      const pathStillOpen = groups.some((group) =>
        group.tabs.some((tab) => tab.path === action.path),
      );
      const tabs = (
        pathStillOpen
          ? state.ide.tabs
          : state.ide.tabs.filter((tab) => tab.path !== action.path)
      ).map((tab) => {
        if (tab.path !== action.path) {
          return tab;
        }
        const ownerGroup = groups.find((group) =>
          group.tabs.some((groupTab) => groupTab.path === tab.path),
        );
        return { ...tab, groupId: ownerGroup?.id };
      });
      let buffers = state.ide.buffers;
      if (!pathStillOpen) {
        const { [action.path]: _closedBuffer, ...remainingBuffers } =
          state.ide.buffers;
        buffers = remainingBuffers;
      }
      const closesActiveGroup =
        !action.groupId || action.groupId === state.ide.layout.activeGroupId;
      let activeGroupId = state.ide.layout.activeGroupId;
      let activePath =
        state.ide.activePath === action.path && closesActiveGroup
          ? (groups.find((group) => group.id === state.ide.layout.activeGroupId)
              ?.activePath ?? (!action.groupId ? tabs.at(-1)?.path : undefined))
          : state.ide.activePath;
      if (!activePath && pathStillOpen && closesActiveGroup) {
        const ownerGroup = groups.find((group) =>
          group.tabs.some((tab) => tab.path === action.path),
        );
        if (ownerGroup) {
          activeGroupId = ownerGroup.id;
          activePath = ownerGroup.activePath ?? action.path;
        }
      }
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath,
          buffers,
          selection:
            state.ide.selection?.path === action.path &&
            activePath !== action.path
              ? undefined
              : state.ide.selection,
          tabs,
          layout: { ...state.ide.layout, activeGroupId, groups },
        },
      };
    }
    case "ide-select-tab":
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: "code",
        ide: {
          ...state.ide,
          activePath: action.path,
          layout: syncEditorGroupsForActivePath(state.ide.layout, action.path),
        },
      };
    case "ide-select-group": {
      const group = state.ide.layout.groups.find(
        (item) => item.id === action.groupId,
      );
      if (!group) {
        return state;
      }
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: "code",
        ide: {
          ...state.ide,
          activePath: group.activePath ?? state.ide.activePath,
          layout: {
            ...state.ide.layout,
            activeGroupId: group.id,
          },
        },
      };
    }
    case "ide-split-group": {
      let group = createEditorGroup(
        nextEditorGroupId(state.ide.layout),
        action.direction === "right" ? "Side" : "Below",
        state.ide.activePath,
      );
      const activeTab = state.ide.tabs.find(
        (tab) => tab.path === state.ide.activePath,
      );
      if (activeTab) {
        group = {
          ...group,
          tabs: group.tabs.map((tab) =>
            tab.path === activeTab.path
              ? { ...tab, ...activeTab, groupId: group.id }
              : tab,
          ),
        };
      }
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: "code",
        ide: {
          ...state.ide,
          layout: {
            ...state.ide.layout,
            activeGroupId: group.id,
            splitDirection: action.direction,
            groups: [...state.ide.layout.groups, group],
          },
        },
      };
    }
    case "ide-close-group": {
      if (
        !state.ide.layout.groups.some((group) => group.id === action.groupId)
      ) {
        return state;
      }
      const remainingGroups = state.ide.layout.groups.filter(
        (group) => group.id !== action.groupId,
      );
      const groups =
        remainingGroups.length > 0
          ? remainingGroups
          : [createEditorGroup("group-main", "Main")];
      const activeGroupId = groups.some(
        (group) => group.id === state.ide.layout.activeGroupId,
      )
        ? state.ide.layout.activeGroupId
        : (groups[0]?.id ?? "group-main");
      const openPaths = new Set(
        groups.flatMap((group) => group.tabs.map((tab) => tab.path)),
      );
      const tabs = state.ide.tabs
        .filter((tab) => openPaths.has(tab.path))
        .map((tab) => {
          const ownerGroup = groups.find((group) =>
            group.tabs.some((groupTab) => groupTab.path === tab.path),
          );
          return { ...tab, groupId: ownerGroup?.id };
        });
      const buffers = Object.fromEntries(
        Object.entries(state.ide.buffers).filter(([path]) =>
          openPaths.has(path),
        ),
      );
      const activePath = groups.find(
        (group) => group.id === activeGroupId,
      )?.activePath;
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath,
          buffers,
          selection:
            state.ide.selection?.path === activePath
              ? state.ide.selection
              : undefined,
          tabs,
          layout: {
            ...state.ide.layout,
            activeGroupId,
            groups,
          },
        },
      };
    }
    case "ide-move-tab": {
      if (
        !state.ide.layout.groups.some((group) => group.id === action.toGroupId)
      ) {
        return state;
      }
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath: action.path,
          tabs: state.ide.tabs.map((tab) =>
            tab.path === action.path
              ? { ...tab, groupId: action.toGroupId }
              : tab,
          ),
          layout: moveTabToEditorGroup(
            state.ide.layout,
            action.path,
            action.toGroupId,
            action.fromGroupId,
          ),
        },
      };
    }
    case "ide-select-view":
      return {
        ...state,
        activeDestination: "workspace",
        activeWorkspaceLayout: "code",
        ide: { ...state.ide, activeView: action.view },
      };
    case "ide-toggle-minimap":
      return {
        ...state,
        ide: {
          ...state.ide,
          layout: {
            ...state.ide.layout,
            minimapEnabled: !state.ide.layout.minimapEnabled,
          },
        },
      };
    case "ide-toggle-assistant":
      return {
        ...state,
        ide: {
          ...state.ide,
          activeView: "ai",
          layout: {
            ...state.ide.layout,
            rightAssistantOpen: !state.ide.layout.rightAssistantOpen,
          },
        },
      };
    case "ide-upsert-buffer": {
      const buffer = action.buffer;
      const dirty = buffer.status === "dirty";
      const tabs = state.ide.tabs.some((tab) => tab.path === buffer.path)
        ? state.ide.tabs.map((tab) =>
            tab.path === buffer.path ? { ...tab, dirty } : tab,
          )
        : [
            ...state.ide.tabs,
            {
              path: buffer.path,
              title: workspaceNameFromPath(buffer.path),
              dirty,
            },
          ];
      const layout = updateEditorTabInLayout(
        upsertPathInActiveEditorGroup(state.ide.layout, buffer.path),
        buffer.path,
        { dirty },
      );
      return {
        ...state,
        ide: {
          ...state.ide,
          activePath: buffer.path,
          buffers: {
            ...state.ide.buffers,
            [buffer.path]: buffer,
          },
          layout,
          tabs,
        },
      };
    }
    case "ide-update-buffer": {
      const existing = state.ide.buffers[action.path];
      if (!existing) {
        return state;
      }
      const dirty = action.content !== existing.savedContent;
      return {
        ...state,
        ide: {
          ...state.ide,
          buffers: {
            ...state.ide.buffers,
            [action.path]: {
              ...existing,
              content: action.content,
              status: dirty ? "dirty" : "ready",
              updatedAt: new Date().toISOString(),
            },
          },
          tabs: state.ide.tabs.map((tab) =>
            tab.path === action.path
              ? {
                  ...tab,
                  dirty,
                  pinned: dirty ? true : tab.pinned,
                  preview: dirty ? false : tab.preview,
                }
              : tab,
          ),
          layout: updateEditorTabInLayout(state.ide.layout, action.path, {
            dirty,
            ...(dirty ? { pinned: true, preview: false } : {}),
          }),
        },
      };
    }
    case "ide-mark-buffer-saved": {
      const existing = state.ide.buffers[action.path];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        ide: {
          ...state.ide,
          buffers: {
            ...state.ide.buffers,
            [action.path]: {
              ...existing,
              content: action.content,
              savedContent: action.content,
              contentHash: action.contentHash,
              error: undefined,
              sizeBytes: action.sizeBytes,
              status: "saved",
              updatedAt: new Date().toISOString(),
            },
          },
          tabs: state.ide.tabs.map((tab) =>
            tab.path === action.path ? { ...tab, dirty: false } : tab,
          ),
          layout: updateEditorTabInLayout(state.ide.layout, action.path, {
            dirty: false,
          }),
        },
      };
    }
    case "ide-mark-buffer-error": {
      const existing = state.ide.buffers[action.path];
      if (!existing) {
        return state;
      }
      return {
        ...state,
        ide: {
          ...state.ide,
          buffers: {
            ...state.ide.buffers,
            [action.path]: {
              ...existing,
              error: action.error,
              status: action.error.includes("changed on disk")
                ? "conflict"
                : "error",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
    }
    case "ide-set-selection":
      return {
        ...state,
        ide: {
          ...state.ide,
          selection: action.selection,
        },
      };
    case "ide-record-assistant-request":
      return {
        ...state,
        ide: {
          ...state.ide,
          lastAssistantRequest: action.request,
          activeView: "ai",
        },
      };
    case "ide-set-search-query":
      return {
        ...state,
        ide: { ...state.ide, activeView: "search", searchQuery: action.query },
      };
    case "ide-set-search-results":
      return {
        ...state,
        ide: {
          ...state.ide,
          activeView: "search",
          searchQuery: action.query,
          searchResults: action.results,
        },
      };
    case "ide-set-diagnostics":
      return {
        ...state,
        ide: { ...state.ide, diagnostics: action.diagnostics },
      };
    case "ide-set-source-control":
      return {
        ...state,
        ide: {
          ...state.ide,
          sourceControl: action.sourceControl,
          fileDecorations: decorationsFromSourceControl(action.sourceControl),
        },
      };
    case "ide-set-tasks":
      return {
        ...state,
        ide: { ...state.ide, taskDefinitions: action.tasks },
      };
    case "ide-set-test-tree":
      return {
        ...state,
        ide: { ...state.ide, testTree: action.tests },
      };
    case "ide-set-debug-session":
      return {
        ...state,
        ide: {
          ...state.ide,
          activeView: "run-test",
          debugSessions: state.ide.debugSessions.some(
            (session) => session.id === action.session.id,
          )
            ? state.ide.debugSessions.map((session) =>
                session.id === action.session.id ? action.session : session,
              )
            : [...state.ide.debugSessions, action.session],
        },
      };
    case "ide-remove-debug-session":
      return {
        ...state,
        ide: {
          ...state.ide,
          debugSessions: state.ide.debugSessions.filter(
            (session) => session.id !== action.sessionId,
          ),
        },
      };
    case "ide-set-language-server":
      return {
        ...state,
        ide: {
          ...state.ide,
          languageServers: state.ide.languageServers.some(
            (server) => server.id === action.server.id,
          )
            ? state.ide.languageServers.map((server) =>
                server.id === action.server.id ? action.server : server,
              )
            : [...state.ide.languageServers, action.server],
        },
      };
    case "ide-remove-language-server":
      return {
        ...state,
        ide: {
          ...state.ide,
          languageServers: state.ide.languageServers.filter(
            (server) => server.serverId !== action.serverId,
          ),
        },
      };
    case "ide-upsert-output-channel":
      return {
        ...state,
        ide: {
          ...state.ide,
          outputChannels: upsertOutputChannel(
            state.ide.outputChannels,
            action.channel,
          ),
          activeOutputChannelId: action.channel.id,
        },
      };
    case "ide-append-output":
      return {
        ...state,
        ide: {
          ...state.ide,
          outputChannels: appendOutputLines(
            state.ide.outputChannels,
            action.channelId,
            action.lines,
          ),
          activeOutputChannelId: action.channelId,
        },
      };
    case "ide-select-output-channel":
      return {
        ...state,
        activePaneTab: "output",
        isToolPanelOpen: true,
        ide: {
          ...state.ide,
          activeOutputChannelId: action.channelId,
        },
      };
    case "ide-register-contribution":
      return {
        ...state,
        ide: {
          ...state.ide,
          contributions: state.ide.contributions.some(
            (item) => item.id === action.contribution.id,
          )
            ? state.ide.contributions.map((item) =>
                item.id === action.contribution.id ? action.contribution : item,
              )
            : [...state.ide.contributions, action.contribution],
        },
      };
    case "ide-record-ai-tool-call":
      return {
        ...state,
        ide: {
          ...state.ide,
          activeView: "ai",
          aiToolCalls: state.ide.aiToolCalls.some(
            (toolCall) => toolCall.id === action.toolCall.id,
          )
            ? state.ide.aiToolCalls.map((toolCall) =>
                toolCall.id === action.toolCall.id ? action.toolCall : toolCall,
              )
            : [action.toolCall, ...state.ide.aiToolCalls].slice(0, 50),
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
      return {
        ...state,
        selectedTerminalPaneId: action.paneId,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId && pane.attention === "waiting"
            ? { ...pane, attention: undefined }
            : pane,
        ),
      };
    case "add-terminal-pane":
      return {
        ...state,
        activeDestination: "workspace",
        activePaneTab: "terminal",
        isToolPanelOpen: true,
        selectedTerminalPaneId: action.pane.id,
        terminalPanes: [...state.terminalPanes, action.pane],
      };
    case "split-terminal-pane":
      return {
        ...state,
        activeDestination: "workspace",
        activePaneTab: "terminal",
        isToolPanelOpen: true,
        selectedTerminalPaneId: action.pane.id,
        terminalTemplate: action.template,
        terminalPanes: [...state.terminalPanes, action.pane],
      };
    case "set-terminal-template":
      return { ...state, terminalTemplate: action.template };
    case "set-terminal-pane-status": {
      const nextActivePaneTab =
        (state.isToolPanelOpen ||
          state.activeWorkspaceLayout === "terminal-grid") &&
        (action.status === "running" ||
          action.status === "waiting" ||
          action.status === "failed")
          ? "terminal"
          : state.activePaneTab;
      if (
        state.activePaneTab === nextActivePaneTab &&
        state.terminalPanes.some(
          (pane) =>
            pane.id === action.paneId &&
            pane.status === action.status &&
            pane.lastEvent === action.event,
        )
      ) {
        return state;
      }
      return {
        ...state,
        activePaneTab: nextActivePaneTab,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? {
                ...pane,
                status: action.status,
                lastEvent: action.event,
                attention:
                  action.status === "failed" ? "failed" : pane.attention,
              }
            : pane,
        ),
      };
    }
    case "sync-terminal-pane-snapshot": {
      const existingPane = state.terminalPanes.find(
        (pane) => pane.id === action.paneId,
      );
      const nextCommand = action.command ?? existingPane?.command;
      const nextProjectPath = action.projectPath ?? existingPane?.projectPath;
      const nextWorkingDirectory =
        action.workingDirectory ?? existingPane?.workingDirectory;
      const nextActivePaneTab =
        (state.isToolPanelOpen ||
          state.activeWorkspaceLayout === "terminal-grid") &&
        (action.status === "running" ||
          action.status === "waiting" ||
          action.status === "failed")
          ? "terminal"
          : state.activePaneTab;
      if (
        existingPane &&
        state.activePaneTab === nextActivePaneTab &&
        existingPane.command === nextCommand &&
        existingPane.projectPath === nextProjectPath &&
        existingPane.workingDirectory === nextWorkingDirectory &&
        existingPane.lastEvent === action.event &&
        existingPane.output === action.output &&
        existingPane.status === action.status
      ) {
        return state;
      }
      return {
        ...state,
        activePaneTab: nextActivePaneTab,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? {
                ...pane,
                command: action.command ?? pane.command,
                lastEvent: action.event,
                output: action.output,
                status: action.status,
                attention:
                  action.status === "failed" ? "failed" : pane.attention,
                projectPath: nextProjectPath,
                workingDirectory: nextWorkingDirectory,
              }
            : pane,
        ),
      };
    }
    case "upsert-restored-terminal-pane": {
      const pane = normalizeTerminalPane(action.pane);
      const exists = state.terminalPanes.some((item) => item.id === pane.id);
      return {
        ...state,
        selectedTerminalPaneId: state.selectedTerminalPaneId || pane.id,
        terminalPanes: exists
          ? state.terminalPanes.map((item) =>
              item.id === pane.id
                ? { ...item, ...pane, layout: pane.layout ?? item.layout }
                : item,
            )
          : [...state.terminalPanes, pane],
      };
    }
    case "set-terminal-pane-attention":
      return {
        ...state,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? { ...pane, attention: action.attention }
            : pane,
        ),
      };
    case "move-terminal-pane":
      return {
        ...state,
        selectedTerminalPaneId: action.sourcePaneId,
        terminalPanes: moveTerminalPane(
          state.terminalPanes,
          action.sourcePaneId,
          action.targetPaneId,
        ),
      };
    case "set-terminal-pane-layout":
      return {
        ...state,
        selectedTerminalPaneId: action.paneId,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId ? { ...pane, layout: action.layout } : pane,
        ),
      };
    case "remove-terminal-pane": {
      const nextPanes = state.terminalPanes.filter(
        (pane) => pane.id !== action.paneId,
      );
      return {
        ...state,
        selectedTerminalPaneId:
          state.selectedTerminalPaneId === action.paneId
            ? (nextPanes[0]?.id ?? "")
            : state.selectedTerminalPaneId,
        terminalPanes: nextPanes,
      };
    }
    case "run-terminal-pane":
      return {
        ...state,
        activeDestination: "workspace",
        activePaneTab: "terminal",
        isToolPanelOpen: true,
        terminalPanes: state.terminalPanes.map((pane) =>
          pane.id === action.paneId
            ? {
                ...pane,
                command: action.command,
                lastEvent: "command queued",
                output: action.output,
                profileId: action.profileId,
                status: "waiting",
                attention: undefined,
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
        activeDestination: "workspace",
        activePaneTab: "diff",
        isToolPanelOpen: true,
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
        activeDestination: "workspace",
        activePaneTab: "diff",
        isToolPanelOpen: true,
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
        activeDestination: "workspace",
        activePaneTab: "browser",
        isToolPanelOpen: true,
        browserPreview: {
          ...state.browserPreview,
          history: nextHistory,
          historyIndex: nextHistory.length - 1,
          status: action.status ?? "loading",
          url: action.url,
          consoleErrors: 0,
          diagnostics: [],
          diagnosticsSupported: false,
          diagnosticsCaptured: false,
          captureStatus: "idle",
          captureError: undefined,
          latestCapture: undefined,
          verificationMessage: "Checking local preview",
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
          status: "loading",
          consoleErrors: 0,
          diagnostics: [],
          diagnosticsCaptured: false,
          captureStatus: "idle",
          captureError: undefined,
          latestCapture: undefined,
          verificationMessage: "Reloading local preview",
        },
      };
    case "browser-device":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          device: action.device,
          captureStatus: "idle",
          captureError: undefined,
          latestCapture: undefined,
        },
      };
    case "browser-capture-start":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          captureStatus: "capturing",
          captureError: undefined,
        },
      };
    case "browser-capture-success":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          captureStatus: "captured",
          captureError: undefined,
          latestCapture: action.capture,
        },
      };
    case "browser-capture-failure":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          captureStatus: "failed",
          captureError: action.error,
        },
      };
    case "browser-status":
      return {
        ...state,
        browserPreview: {
          ...state.browserPreview,
          consoleErrors:
            action.consoleErrors ?? state.browserPreview.consoleErrors,
          diagnostics: action.diagnostics ?? state.browserPreview.diagnostics,
          diagnosticsSupported:
            action.diagnosticsSupported ??
            state.browserPreview.diagnosticsSupported,
          diagnosticsCaptured:
            action.diagnosticsCaptured ??
            state.browserPreview.diagnosticsCaptured,
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
                authOwner: action.details?.authOwner ?? provider.authOwner,
                healthDetails: action.details ?? provider.healthDetails,
                healthCheckedAt: new Date().toISOString(),
                healthOutput: action.output,
                healthSummary: action.summary,
                runtimeStatus:
                  action.details?.runtimeStatus ?? provider.runtimeStatus,
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

function moveTerminalPane(
  panes: TerminalPane[],
  sourcePaneId: string,
  targetPaneId: string,
): TerminalPane[] {
  if (sourcePaneId === targetPaneId) {
    return panes;
  }
  const sourceIndex = panes.findIndex((pane) => pane.id === sourcePaneId);
  const targetIndex = panes.findIndex((pane) => pane.id === targetPaneId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return panes;
  }
  const next = [...panes];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) {
    return panes;
  }
  next.splice(targetIndex, 0, source);
  return next;
}

export function createTerminalPane(
  id: string,
  profile: CommandProfile,
  status: TerminalPaneStatus = "restored",
  options: {
    workspaceMode?: WorkbenchMode;
    branch?: string;
    worktreeName?: string;
    projectPath?: string;
    workingDirectory?: string;
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
    projectPath: options.projectPath,
    workingDirectory: options.workingDirectory,
    createdAt: new Date().toISOString(),
  };
}

function normalizeTerminalPane(pane: TerminalPane): TerminalPane {
  const workspaceMode = pane.workspaceMode ?? "local";
  const layout = ["auto", "wide", "compact"].includes(pane.layout ?? "")
    ? pane.layout
    : undefined;
  return {
    ...pane,
    workspaceMode,
    branch:
      pane.branch ?? (workspaceMode === "worktree" ? "gyro/worktree" : "main"),
    worktreeName: pane.worktreeName,
    projectPath: pane.projectPath,
    workingDirectory: pane.workingDirectory,
    attention:
      pane.attention === "waiting" || pane.attention === "failed"
        ? pane.attention
        : undefined,
    layout,
  };
}

export function defaultCliLaunchPreset(): CliLaunchPreset {
  return {
    entries: [{ profileId: "shell", count: 1 }],
    focus: "first",
  };
}

export function normalizeCliLaunchPreset(
  preset?: Partial<CliLaunchPreset>,
  profiles: CommandProfile[] = defaultCommandProfiles(),
): CliLaunchPreset {
  const allowedProfileIds = new Set(profiles.map((profile) => profile.id));
  const entries = Array.isArray(preset?.entries)
    ? preset.entries
        .map((entry) => ({
          count: Math.max(
            1,
            Math.min(
              CLI_LAUNCH_PRESET_MAX_PANES,
              Number.isFinite(entry?.count) ? Math.floor(entry.count) : 1,
            ),
          ),
          profileId:
            typeof entry?.profileId === "string" ? entry.profileId : "",
        }))
        .filter((entry) => allowedProfileIds.has(entry.profileId))
    : [];

  const cappedEntries: CliLaunchPreset["entries"] = [];
  let total = 0;
  for (const entry of entries) {
    const remaining = CLI_LAUNCH_PRESET_MAX_PANES - total;
    if (remaining <= 0) {
      break;
    }
    const count = Math.min(entry.count, remaining);
    cappedEntries.push({ ...entry, count });
    total += count;
  }

  const fallback = defaultCliLaunchPreset();
  if (cappedEntries.length === 0) {
    return fallback;
  }
  return {
    label:
      typeof preset?.label === "string" && preset.label.trim()
        ? preset.label.trim()
        : undefined,
    entries: cappedEntries,
    focus: preset?.focus === "last" ? "last" : "first",
  };
}

function normalizeWorkbenchPreferences(
  preferences?: Partial<WorkbenchPreferences>,
): WorkbenchPreferences {
  return {
    activeChatPanel: preferences?.activeChatPanel,
    chatEnvironmentRailOpen: preferences?.chatEnvironmentRailOpen === true,
    cliLaunchPreset: normalizeCliLaunchPreset(preferences?.cliLaunchPreset),
    commandPaletteRecents: Array.isArray(preferences?.commandPaletteRecents)
      ? preferences.commandPaletteRecents.filter(
          (commandId): commandId is string => typeof commandId === "string",
        )
      : [],
    density: preferences?.density === "comfortable" ? "comfortable" : "compact",
    lastSettingsSection: preferences?.lastSettingsSection ?? "general",
    sidebarChatsCollapsed: preferences?.sidebarChatsCollapsed === true,
    theme: preferences?.theme === "dark" ? "dark" : "light",
    usageProviderId: preferences?.usageProviderId,
    usageVisualization:
      preferences?.usageVisualization === "wheels" ? "wheels" : "bars",
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
      args: ["-il"],
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
      id: "kimi-code",
      displayName: "Kimi Code",
      command: "kimi",
      args: [],
      workingDirectory: "Workspace",
      providerId: "kimi",
      defaultModel: "k3",
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
  return catalogDefaultProviderStatuses();
}

export function parseProviderHealthOutput(
  providerId: string,
  output: string,
): Pick<
  ProviderStatus,
  "connectionStatus" | "healthSummary" | "runtimeStatus" | "authOwner"
> & {
  healthDetails: ProviderHealthDetails;
} {
  const normalized = output.trim().toLowerCase();
  const providerLabel = providerId === "custom" ? "Custom command" : providerId;
  const authOwner = inferProviderAuthOwner(providerId, normalized);
  const secretStorage =
    authOwner === "provider-env"
      ? "Environment variable or provider SDK store"
      : authOwner === "provider-sdk"
        ? "Provider SDK or OS credential store"
        : "Provider CLI, OS Keychain, or provider-owned files";
  const baseDetails: ProviderHealthDetails = {
    authOwner,
    diagnosticsOptIn: false,
    privacyNote:
      "Gyro stores readiness summaries only; provider tokens stay outside Gyro.",
    runtimeStatus: "unknown",
    secretStorage,
    ...extractProviderHealthMetadata(normalized),
  };

  if (!normalized) {
    return {
      authOwner,
      connectionStatus: "disconnected",
      healthDetails: {
        ...baseDetails,
        runtimeStatus: "unknown",
      },
      healthSummary: "No health output returned.",
      runtimeStatus: "unknown",
    };
  }

  if (
    /\b(command not found|not installed|no such file or directory|cannot find|not recognized)\b/.test(
      normalized,
    )
  ) {
    return {
      authOwner,
      connectionStatus: "not-configured",
      healthDetails: {
        ...baseDetails,
        runtimeStatus: "not-installed",
      },
      healthSummary: `${providerLabel} is not installed on this device.`,
      runtimeStatus: "not-installed",
    };
  }

  if (
    /\b(not configured|missing|no api key|no credential|credential missing|unauthenticated|not authenticated|logged out|not logged in|auth required|setup required)\b/.test(
      normalized,
    ) ||
    /"loggedin"\s*:\s*false/.test(normalized)
  ) {
    return {
      authOwner,
      connectionStatus: "not-configured",
      healthDetails: {
        ...baseDetails,
        runtimeStatus: "not-logged-in",
      },
      healthSummary: "Credentials or local login are not configured.",
      runtimeStatus: "not-logged-in",
    };
  }

  if (
    /\b(error|failed|failure|timeout|timed out|unreachable|denied|invalid|crashed|not found|warning)\b/.test(
      normalized,
    )
  ) {
    return {
      authOwner,
      connectionStatus: "failed",
      healthDetails: {
        ...baseDetails,
        runtimeStatus: "warning",
      },
      healthSummary: "Health check failed. Inspect the provider setup.",
      runtimeStatus: "warning",
    };
  }

  if (
    /\b(authenticated|logged in|ready|healthy|ok|connected|verified|available)\b/.test(
      normalized,
    ) ||
    /"loggedin"\s*:\s*true/.test(normalized)
  ) {
    return {
      authOwner,
      connectionStatus: "connected",
      healthDetails: {
        ...baseDetails,
        runtimeStatus: "ready",
      },
      healthSummary: `${providerLabel} is ready for local handoff.`,
      runtimeStatus: "ready",
    };
  }

  return {
    authOwner,
    connectionStatus: "disconnected",
    healthDetails: {
      ...baseDetails,
      runtimeStatus: "unknown",
    },
    healthSummary: "Health output was inconclusive.",
    runtimeStatus: "unknown",
  };
}

function inferProviderAuthOwner(
  providerId: string,
  output: string,
): ProviderHealthDetails["authOwner"] {
  if (
    providerId === "xai" ||
    providerId === "gemini" ||
    /\b(provider-env|environment|env auth|env-owned)\b/.test(output)
  ) {
    return "provider-env";
  }
  if (/\b(provider-sdk|sdk-owned)\b/.test(output)) {
    return "provider-sdk";
  }
  return "provider-cli";
}

function extractProviderHealthMetadata(
  output: string,
): Partial<ProviderHealthDetails> {
  const metadata: Partial<ProviderHealthDetails> = {};
  const subscription = output.match(
    /"subscription(?:type|tier|label)"\s*:\s*"([^"]+)"/,
  );
  const account = output.match(/"(?:account|email|user)"\s*:\s*"([^"]+)"/);
  const mode = output.match(
    /"(?:mode|authmode|provider_mode)"\s*:\s*"([^"]+)"/,
  );
  if (subscription?.[1]) {
    metadata.subscriptionLabel = subscription[1];
  }
  if (account?.[1]) {
    metadata.accountLabel = account[1];
  }
  if (mode?.[1]) {
    metadata.providerMode = mode[1];
  }
  return metadata;
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
    url: "http://localhost:3000",
    history: ["http://localhost:3000"],
    historyIndex: 0,
    device: "desktop" as const,
    consoleErrors: 0,
    diagnostics: [],
    diagnosticsSupported: false,
    diagnosticsCaptured: false,
    captureStatus: "idle" as const,
    captureError: undefined,
    latestCapture: undefined,
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

function workspaceLayoutForLegacySurface(
  surface: SurfaceId,
): WorkspaceLayoutId {
  if (surface === "cli") {
    return "terminal-grid";
  }
  if (surface === "ide") {
    return "code";
  }
  return "thread";
}

function isSessionsLayout(
  layout: WorkspaceLayoutId,
): layout is SessionsLayoutId {
  return layout === "thread" || layout === "terminal-grid";
}

function chatPanelState(
  state: WorkbenchState,
  panel?: ChatSidePanelId,
): WorkbenchState {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      activeChatPanel: panel,
      chatEnvironmentRailOpen: panel !== undefined,
    },
  };
}

function normalizeEditorTab(tab: EditorTab): EditorTab {
  return {
    ...tab,
    title: tab.title || workspaceNameFromPath(tab.path),
    dirty: tab.dirty === true,
  };
}

function workspaceNameFromPath(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function isUserSelectedWorkspacePath(path?: string) {
  if (!path?.trim()) {
    return false;
  }
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return !/^gyro-.+-\d{8,}$/i.test(name);
}

export function canSendChat(providerReady: boolean, workspacePath?: string) {
  return providerReady && isUserSelectedWorkspacePath(workspacePath);
}

function browserHistoryState(
  state: WorkbenchState,
  historyIndex: number,
): WorkbenchState {
  const url =
    state.browserPreview.history[historyIndex] ?? state.browserPreview.url;

  return {
    ...state,
    activeDestination: "workspace",
    activePaneTab: "browser",
    isToolPanelOpen: true,
    browserPreview: {
      ...state.browserPreview,
      historyIndex,
      status: "loading",
      url,
      consoleErrors: 0,
      diagnostics: [],
      diagnosticsSupported: false,
      diagnosticsCaptured: false,
      captureStatus: "idle",
      captureError: undefined,
      latestCapture: undefined,
      verificationMessage: "Checking history target",
    },
  };
}

function nextOnboardingStep(step: OnboardingStepId): OnboardingStepId {
  const order: OnboardingStepId[] = [
    "account",
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
