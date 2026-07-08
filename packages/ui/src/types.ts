export type SessionOrigin = "cli" | "desktop";

export type SurfaceId = "chat" | "cli" | "ide";

export type WorkspaceLayoutId = "thread" | "terminal-grid" | "code";

export type AppDestination =
  | "workspace"
  | "tools"
  | "settings"
  | "tasks"
  | "automations"
  | "providers"
  | "onboarding";

export type ThemeMode = "dark" | "light";

export type WorkbenchPaneTab = "diff" | "terminal" | "browser";

export type WorkbenchDensity = "comfortable" | "compact";

export type WorkbenchMode = "local" | "worktree";

export type ChatSidePanelId = "environment" | "plan";

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

export type ProviderId =
  "openai" | "anthropic" | "xai" | "cursor" | "gemini" | "opencode";

export type ProviderAuthMode = "cli" | "env" | "sdk";

export type ProviderAuthStatus =
  "not-connected" | "connecting" | "connected" | "failed";

export type ProviderRuntimeStatus =
  "not-installed" | "not-logged-in" | "ready" | "warning" | "unknown";

export type ProviderAuthOwner =
  "provider-cli" | "provider-env" | "provider-sdk";

export type ProviderHealthDetails = {
  runtimeStatus: ProviderRuntimeStatus;
  authOwner: ProviderAuthOwner;
  authCommand?: string;
  loginCommand?: string;
  accountLabel?: string;
  subscriptionLabel?: string;
  providerMode?: string;
  secretStorage: string;
  privacyNote: string;
  diagnosticsOptIn: boolean;
};

export type ProviderModel = {
  id: string;
  displayName: string;
  description?: string;
};

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
  runtimeStatus?: ProviderRuntimeStatus;
  authOwner?: ProviderAuthOwner;
  healthDetails?: ProviderHealthDetails;
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

export type SessionPlanItemStatus =
  "todo" | "in-progress" | "complete" | "blocked";

export type SessionPlanItem = {
  id: string;
  title: string;
  detail?: string;
  status: SessionPlanItemStatus;
  sourceTurnId?: string;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionPlan = {
  sessionId?: string;
  title: string;
  items: SessionPlanItem[];
  sourceTurnId?: string;
  providerId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OnboardingStepId =
  | "account"
  | "welcome"
  | "theme"
  | "workspace"
  | "provider"
  | "approval"
  | "first-session";

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
  activeChatPanel?: ChatSidePanelId;
  cliLaunchPreset: CliLaunchPreset;
};

export type CliLaunchPresetFocus = "first" | "last";

export type CliLaunchPresetEntry = {
  profileId: string;
  count: number;
};

export type CliLaunchPreset = {
  label?: string;
  entries: CliLaunchPresetEntry[];
  focus: CliLaunchPresetFocus;
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

export type EditorTab = {
  path: string;
  title: string;
  dirty: boolean;
  pinned?: boolean;
};

export type EditorBufferStatus =
  | "idle"
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

export type EditorBuffer = {
  path: string;
  content: string;
  savedContent: string;
  contentHash?: string;
  sizeBytes: number;
  truncated: boolean;
  status: EditorBufferStatus;
  error?: string;
  updatedAt: string;
};

export type EditorSelection = {
  path: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  text: string;
};

export type IdeAssistantAction =
  | "explain-selection"
  | "fix-selection"
  | "refactor-file"
  | "generate-tests"
  | "ask-about-file"
  | "apply-proposed-edit";

export type IdeAssistantRequest = {
  id: string;
  action: IdeAssistantAction;
  instruction: string;
  path?: string;
  selection?: EditorSelection;
  visibleTabs: string[];
  providerId?: string;
  model?: string;
  createdAt: string;
};

export type IdeSessionEventPayloadKind =
  | "editor-file-opened"
  | "editor-selection-changed"
  | "ai-editor-requested"
  | "ai-edit-proposed"
  | "file-write-approved"
  | "file-write-rejected";

export type IdeState = {
  tabs: EditorTab[];
  activePath?: string;
  buffers: Record<string, EditorBuffer>;
  selection?: EditorSelection;
  lastAssistantRequest?: IdeAssistantRequest;
};

export type WorkbenchState = {
  activeDestination: AppDestination;
  activeWorkspaceLayout: WorkspaceLayoutId;
  activePaneTab: WorkbenchPaneTab;
  isToolPanelOpen: boolean;
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
  ide: IdeState;
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
  providerId?: ProviderId;
  providerLabel?: string;
  modelId?: string;
  modelLabel?: string;
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
    | "plan-updated"
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
  providerId?: string | null;
  defaultModel?: string | null;
  readiness?: "ready" | "waiting" | "blocked";
};

export type ModelProviderConfig = {
  id: ProviderId;
  displayName: string;
  baseUrl?: string | null;
  apiKeyRef: string;
  enabled: boolean;
  authMode: ProviderAuthMode;
  authStatus: ProviderAuthStatus;
  models: ProviderModel[];
  selectedModelId?: string;
};

export type GyroAccountStatus =
  "checking" | "signed-out" | "signing-in" | "signed-in" | "failed";

export type GyroAccountSession = {
  signedIn: boolean;
  userId?: string | null;
  email?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  issuer?: string | null;
  expiresAt?: string | null;
};

export type GyroAccountOidcConfig = {
  issuerUrl: string;
  clientId: string;
  redirectLoopbackBase: string;
  scopes: string[];
};

export type GyroConfig = {
  updateChannel: "stable" | "beta" | "nightly";
  telemetryEnabled: boolean;
  requireCommandApproval: boolean;
  requireFileEditApproval: boolean;
  accountOidc?: GyroAccountOidcConfig;
  accountSession?: GyroAccountSession;
  selectedProviderId?: ProviderId;
  modelProviders: ModelProviderConfig[];
  commandProfiles: CommandProfile[];
};

export type WorkspaceFile = {
  path: string;
  kind: "file" | "directory";
  depth?: number;
};

export type WorkspaceFileContent = {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  contentHash?: string;
};

export type WorkspaceFileStat = {
  path: string;
  kind: "file" | "directory";
  sizeBytes: number;
  contentHash?: string;
};
