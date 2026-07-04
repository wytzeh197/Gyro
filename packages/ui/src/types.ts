export type SessionOrigin = "cli" | "desktop";

export type SurfaceId = "chat" | "cli" | "ide";

export type AppDestination =
  | SurfaceId
  | "settings"
  | "tasks"
  | "automations"
  | "providers"
  | "diff"
  | "browser"
  | "onboarding";

export type ThemeMode = "dark" | "light";

export type WorkbenchPaneTab = "diff" | "terminal" | "browser";

export type WorkbenchDensity = "comfortable" | "compact";

export type WorkbenchMode = "local" | "worktree";

export type SettingsSectionId =
  | "general"
  | "providers"
  | "usage-limits"
  | "cli-profiles"
  | "appearance"
  | "permissions"
  | "updates"
  | "keyboard"
  | "advanced"
  | "about";

export type TerminalPaneStatus =
  "restored" | "running" | "waiting" | "done" | "failed";

export type TerminalTemplate = 1 | 2 | 4 | 6 | 8 | 12 | 16;

export type TerminalPane = {
  id: string;
  title: string;
  profileId: string;
  command: string;
  output: string;
  status: TerminalPaneStatus;
  lastEvent: string;
  workspaceMode: WorkbenchMode;
  branch: string;
  worktreeName?: string;
  createdAt: string;
};

export type TaskStatus = "todo" | "in-progress" | "in-review" | "complete";

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  repo: string;
  agent: string;
  branch: string;
  workspaceMode: WorkbenchMode;
  worktreeName?: string;
  lastEvent: string;
  diffStatus: string;
  testStatus: string;
  timeRunning: string;
  attentionNeeded: boolean;
  terminalPaneId?: string;
};

export type AutomationStatus = "current" | "paused" | "completed";

export type AutomationSchedule =
  "manual" | "hourly" | "daily" | "weekly" | "heartbeat";

export type AutomationRunStatus =
  "queued" | "running" | "passed" | "failed" | "stopped";

export type AutomationTriageState = "none" | "needs-review" | "archived";

export type AutomationRun = {
  id: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  summary: string;
};

export type Automation = {
  id: string;
  title: string;
  prompt: string;
  schedule: AutomationSchedule;
  status: AutomationStatus;
  triageState: AutomationTriageState;
  project: string;
  provider: string;
  branch: string;
  workspaceMode: WorkbenchMode;
  worktreeName?: string;
  stopCondition?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastResult: string;
  unreadResults: number;
  runHistory: AutomationRun[];
  createdAt?: string;
  updatedAt?: string;
};

export type DiffSource = "agent-generated" | "user-edited" | "mixed" | "stale";

export type DiffFileState = "pending" | "accepted" | "rejected";

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  number: number;
  kind: DiffLineKind;
  content: string;
};

export type DiffFile = {
  path: string;
  additions: number;
  deletions: number;
  source: DiffSource;
  state: DiffFileState;
  turnId?: string;
  lines: DiffLine[];
  comments: number;
};

export type DiffApprovalState =
  "pending" | "approved" | "rejected" | "partially-approved";

export type GitReviewActionId = "create-branch" | "commit" | "push" | "open-pr";

export type GitReviewActionStatus = "blocked" | "ready" | "done" | "failed";

export type GitReviewAction = {
  id: GitReviewActionId;
  label: string;
  detail: string;
  status: GitReviewActionStatus;
  lastRunAt?: string;
};

export type DiffReview = {
  files: DiffFile[];
  selectedPath: string;
  approvalState: DiffApprovalState;
  commitMessage: string;
  activeTurnId?: string;
  collapsedDirectories: string[];
  gitActions: GitReviewAction[];
  lastAction?: string;
};

export type BrowserPreviewDevice = "desktop" | "tablet" | "mobile";

export type BrowserPreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "console-error"
  | "verification-passed"
  | "verification-failed";

export type BrowserPreview = {
  url: string;
  history: string[];
  historyIndex: number;
  device: BrowserPreviewDevice;
  consoleErrors: number;
  screenshotCount: number;
  status: BrowserPreviewStatus;
  verificationMessage: string;
};

export type NotificationKind =
  | "approval"
  | "terminal"
  | "command-failed"
  | "tests-passed"
  | "diff-ready"
  | "browser-failed"
  | "update"
  | "provider";

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  createdAt: string;
  read: boolean;
};

export type ProviderConnectionStatus =
  "not-configured" | "checking" | "connected" | "failed" | "disconnected";

export type ProviderReadinessStatus = "idle" | "checking" | "ready" | "blocked";

export type ProviderReadiness = {
  status: ProviderReadinessStatus;
  message: string;
  providerId?: string;
  checkedAt?: string;
};

export type ProviderStatus = {
  id: string;
  displayName: string;
  connectionStatus: ProviderConnectionStatus;
  healthCheckedAt?: string;
  healthOutput?: string;
  healthSummary?: string;
  defaultModel: string;
  effort: "low" | "medium" | "high" | "extra-high";
  allowedTools: string[];
  approvalPolicy: "ask" | "allow";
};

export type ProviderSessionStatus =
  "ready" | "queued" | "running" | "waiting" | "done" | "failed";

export type ProviderSession = {
  id: string;
  providerId: string;
  displayName: string;
  status: ProviderSessionStatus;
  model: string;
  sessionId?: string;
  sessionTitle: string;
  workspaceMode: WorkbenchMode;
  branch?: string;
  worktreeName?: string;
  lastEvent: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderHandoffStatus =
  "queued" | "waiting" | "accepted" | "failed";

export type ProviderHandoff = {
  id: string;
  fromProviderId: string;
  fromLabel: string;
  toProviderId: string;
  toLabel: string;
  status: ProviderHandoffStatus;
  sessionId?: string;
  sessionTitle: string;
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
};

export type OnboardingStepId =
  "welcome" | "theme" | "workspace" | "provider" | "approval" | "first-session";

export type OnboardingState = {
  activeStep: OnboardingStepId;
  completedSteps: OnboardingStepId[];
};

export type WorkbenchPreferences = {
  theme: ThemeMode;
  density: WorkbenchDensity;
  lastSettingsSection: SettingsSectionId;
  commandPaletteRecents: string[];
  sidebarChatsCollapsed: boolean;
  chatEnvironmentRailOpen: boolean;
};

export type WorkbenchTurnStatus =
  "queued" | "running" | "waiting" | "done" | "failed";

export type WorkbenchTurn = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  status: WorkbenchTurnStatus;
  startedAt: string;
  updatedAt: string;
  lastEvent: string;
  changedFiles: number;
  approvalsPending: number;
  reconciledAt?: string;
};

export type WorkbenchState = {
  activeDestination: AppDestination;
  activePaneTab: WorkbenchPaneTab;
  workspaceMode: WorkbenchMode;
  selectedTerminalPaneId: string;
  terminalTemplate: TerminalTemplate;
  terminalPanes: TerminalPane[];
  tasks: Task[];
  selectedTaskId?: string;
  automations: Automation[];
  selectedAutomationId?: string;
  diffReview: DiffReview;
  browserPreview: BrowserPreview;
  notifications: Notification[];
  providerStatuses: ProviderStatus[];
  providerSessions: ProviderSession[];
  providerHandoffs: ProviderHandoff[];
  selectedProviderSessionId?: string;
  providerReadiness: ProviderReadiness;
  activeTurn?: WorkbenchTurn;
  onboarding: OnboardingState;
  preferences: WorkbenchPreferences;
};

export type Session = {
  id: string;
  title: string;
  workspacePath: string;
  origin: SessionOrigin;
  workspaceMode?: WorkbenchMode;
  branch?: string;
  worktreeName?: string;
  createdAt: string;
  updatedAt: string;
  eventsPath: string;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  createdAt: string;
  turnId?: string;
  kind:
    | "session-created"
    | "user-message"
    | "assistant-message"
    | "command-requested"
    | "command-output"
    | "file-edit-proposed"
    | "approval-requested"
    | "system-event";
  message: string;
  payload: unknown;
};

export type CommandProfile = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  workingDirectory?: string | null;
};

export type ModelProviderConfig = {
  id: string;
  displayName: string;
  baseUrl?: string | null;
  apiKeyRef: string;
  enabled: boolean;
};

export type GyroConfig = {
  updateChannel: "stable" | "beta" | "nightly";
  telemetryEnabled: boolean;
  requireCommandApproval: boolean;
  requireFileEditApproval: boolean;
  modelProviders: ModelProviderConfig[];
  commandProfiles: CommandProfile[];
};

export type WorkspaceFile = {
  path: string;
  kind: "file" | "directory";
};

export type WorkspaceFileContent = {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
};
