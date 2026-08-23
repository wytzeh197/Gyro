export type SessionOrigin = "cli" | "desktop";

/** Chat is a single-agent thread; mission is a goal chat that can own CLI workers. */
export type SessionKind = "chat" | "mission";

export type SurfaceId = "chat" | "cli" | "ide";

export type WorkspaceLayoutId = "thread" | "terminal-grid" | "code";

export type SessionsLayoutId = Exclude<WorkspaceLayoutId, "code">;

export type AppDestination =
  | "workspace"
  | "tools"
  | "settings"
  | "tasks"
  | "automations"
  | "providers"
  | "onboarding";

export type ThemeMode = "dark" | "light";

export type WorkbenchPaneTab =
  "diff" | "terminal" | "browser" | "problems" | "output" | "test-results";

export type WorkbenchDensity = "comfortable" | "compact";

export type WorkbenchMode = "local" | "worktree";

/**
 * What the right pane is showing. `environment` is the launcher the pane falls
 * back to; every other id is a tool that took the pane over in place, so
 * picking one never closes the pane.
 */
export type ChatSidePanelId =
  | "environment"
  | "plan"
  | "browser"
  | "changes"
  | "terminal";

export type ChatMode = "normal" | "plan" | "council";

export type ChatPaneRef =
  | {
      paneId: string;
      kind: "session";
      sessionId: string;
      workspacePath: string;
    }
  | {
      paneId: string;
      kind: "draft";
      draftKey: string;
      workspacePath: string;
    };

export type ChatGridArrangement = "grid" | "columns" | "rows";

export type ChatProjectLayout = {
  projectKey: string;
  slots: Array<ChatPaneRef | null>;
  focusedPaneId?: string;
  splitDirection?: "horizontal" | "vertical";
  /**
   * How occupied panes are tiled once there are two or more:
   * - "columns": all panes side by side in a single row (e.g. "3 next to each other").
   * - "rows": all panes stacked in a single column ("fully under").
   * - "grid": 2×2 quadrants (only meaningful with 3–4 panes).
   * When unset the surface falls back to a sensible default per pane count.
   */
  arrangement?: ChatGridArrangement;
};

export type ChatGridState = {
  activeProjectKey?: string;
  layouts: Record<string, ChatProjectLayout>;
  maximizedPaneId?: string;
};

export type CapabilityId =
  | "workspace-context"
  | "workspace-list"
  | "workspace-search"
  | "workspace-read"
  | "workspace-read-range"
  | "workspace-diagnostics"
  | "workspace-git-status"
  | "workspace-diff"
  | "workspace-propose-edit"
  | "workspace-run-task"
  | "workspace-run-test"
  | "workspace-read-output"
  | "ide-reveal"
  | "ide-open-panel"
  | "terminal-open"
  | "terminal-read"
  | "terminal-stop"
  | "browser-open"
  | "browser-inspect"
  | "browser-reload"
  | "browser-screenshot"
  | "browser-navigate"
  | "browser-back"
  | "browser-forward"
  | "browser-click"
  | "browser-type"
  | "browser-scroll"
  | "browser-form-input"
  | "browser-read-page"
  | "browser-find"
  | "browser-console"
  | "browser-network";

export type CapabilityClass =
  | "workspace-inspect"
  | "workspace-sensitive-read"
  | "ide-reveal"
  | "terminal-execute"
  | "terminal-observe"
  | "browser-inspect"
  | "browser-navigate";

export type CapabilityAccess = "deny" | "ask" | "allow";
export type CapabilityStatus =
  | "requested"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "inactive";

export type CapabilityApprovalDecision =
  "deny" | "allow-once" | "allow-project";

export type CapabilityRunMode = "normal" | "plan" | "council";

export type CapabilityInvocationContext = {
  sessionId: string;
  turnId?: string;
  providerId: string;
  runNonce: string;
  callId: string;
  workspaceKey: string;
  mode: CapabilityRunMode;
  policyRevision: number;
  workspaceContextRevision: number;
};

export type WorkspaceContextSnapshot = {
  schema: "gyro.workspace-context.v1";
  workspaceKey: string;
  revision: number;
  capturedAt: string;
  activePath?: string;
  activeView?: IdeViewId;
  visibleTabs: string[];
  selection?: EditorSelection;
  buffers: Array<{
    path: string;
    dirty: boolean;
    contentHash?: string;
    diskHash?: string;
    content?: string;
  }>;
  diagnostics: ProblemDiagnostic[];
  testFailures: TestTreeItem[];
  activeOutput?: OutputChannel;
};

export type CapabilityRequest = {
  schema: "gyro.provider-capability-ipc.v1";
  senderVersion: string;
  context: CapabilityInvocationContext;
  capabilityId: CapabilityId;
  arguments: Record<string, unknown>;
};

export type ProjectCapabilityGrant = {
  id: string;
  class: CapabilityClass;
  scopeKind: string;
  scopeValue: string;
  createdAt: string;
};

export type ProjectCapabilityPolicy = {
  schema: "gyro.capability.v1";
  workspaceKey: string;
  revision: number;
  classes: Record<CapabilityClass, CapabilityAccess>;
  grants: ProjectCapabilityGrant[];
  updatedAt: string;
};

export type CapabilityResourceRef = {
  id: string;
  kind: "workspace" | "ide" | "terminal" | "browser" | "proposal" | "output";
  label: string;
};

export type CapabilityResult = {
  callId: string;
  capabilityId: CapabilityId;
  summary: string;
  data: unknown;
  resource?: CapabilityResourceRef;
};

export type CapabilityError = {
  code: string;
  message: string;
};

export type CapabilityCallEvent = {
  schema: "gyro.capability.v1";
  kind: "capability-call";
  callId: string;
  capabilityId: CapabilityId;
  status: CapabilityStatus;
  providerId: string;
  policyRevision: number;
  summary: string;
  resource?: CapabilityResourceRef;
};

export type CapabilityApprovalEvent = {
  schema: "gyro.capability.v1";
  kind: "capability-approval";
  approvalId: string;
  callId: string;
  capabilityId: CapabilityId;
  capabilityClass: CapabilityClass;
  providerId: string;
  status: "waiting";
  scopeKind: string;
  scopeValue: string;
  choices: CapabilityApprovalDecision[];
};

export type CapabilityActivity = CapabilityCallEvent & {
  sessionId: string;
  turnId?: string;
  createdAt: string;
};

export type ProviderCapabilitySupport = {
  providerId: string;
  available: boolean;
  capabilities: CapabilityId[];
  reason?: string;
};

export type ModelResourceOwner = {
  kind: "model";
  sessionId: string;
  turnId?: string;
  callId: string;
};

export type ChatBrowserResource = {
  id: string;
  sessionId: string;
  projectPath: string;
  url: string;
  status: CapabilityStatus;
  label: string;
  latestCapturePath?: string;
};

export type SessionGoalStatus = "active" | "complete";

export type SessionGoal = {
  sessionId?: string;
  text: string;
  status: SessionGoalStatus;
  sourceTurnId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ChatAttachmentKind =
  "ide-snapshot" | "image" | "video" | "workspace-file";

export type ChatAttachment = {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  path: string;
  relativePath?: string;
  mimeType?: string;
  size: number;
  contentHash?: string;
  modifiedAt?: string;
  available?: boolean;
  stale?: boolean;
  previewUrl?: string;
};

export type SettingsSectionId =
  | "general"
  | "editor-workspace"
  | "tools-contributions"
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
export type TerminalPaneAttention = "waiting" | "failed";

export type TerminalTemplate = 1 | 2 | 4 | 6 | 8 | 12 | 16;
export type TerminalPaneLayout = "auto" | "wide" | "compact";

export type TerminalPane = {
  id: string;
  title: string;
  profileId: string;
  command: string;
  output: string;
  status: TerminalPaneStatus;
  hasForegroundJob?: boolean;
  lastEvent: string;
  workspaceMode: WorkbenchMode;
  branch: string;
  worktreeName?: string;
  projectPath?: string;
  workingDirectory?: string;
  attention?: TerminalPaneAttention;
  layout?: TerminalPaneLayout;
  createdAt: string;
  owner?: ModelResourceOwner;
  /**
   * Set only once the backend confirms the pane launched under Gyro's approval
   * policy, so the CLI surface reports governance rather than claiming it.
   */
  governedSessionId?: string;
  governedProviderId?: string;
  /** Parent mission chat session when this pane is a mission worker. */
  missionSessionId?: string;
  /** Short task label for the mission board (not the profile display name). */
  taskTitle?: string;
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
  stopConditionMet?: boolean;
};

export type AutomationExecutionContext = {
  workspacePath?: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  modelLabel?: string;
  reasoningEffort?: string;
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
  execution?: AutomationExecutionContext;
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

export type MenuBarJobKind = "chat" | "automation";

export type MenuBarJobStatus = "queued" | "running" | "waiting" | "finished";

export type MenuBarJob = {
  id: string;
  kind: MenuBarJobKind;
  targetId: string;
  title: string;
  detail: string;
  status: MenuBarJobStatus;
  startedAt: string;
  canStop: boolean;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  modelLabel?: string;
};

export type MenuBarOutcome = {
  id: string;
  kind: MenuBarJobKind;
  targetId: string;
  title: string;
  detail: string;
  status: "succeeded" | "failed" | "stopped";
  finishedAt: string;
};

export type MenuBarSnapshotState =
  "idle" | "working" | "attention" | "complete";

export type MenuBarSnapshot = {
  state: MenuBarSnapshotState;
  jobs: MenuBarJob[];
  totalActive: number;
  recentOutcome?: MenuBarOutcome;
  theme: ThemeMode;
  reduceMotion: boolean;
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

export type GitReviewActionStatus =
  "blocked" | "ready" | "running" | "done" | "failed";

export type GitReviewAction = {
  id: GitReviewActionId;
  label: string;
  detail: string;
  status: GitReviewActionStatus;
  lastRunAt?: string;
  /** Message from the backend when `status` is `failed`. */
  error?: string;
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

export type BrowserPreviewDiagnostic = {
  kind: "console-error" | "page-error" | "unhandled-rejection";
  message: string;
  source?: string;
  line?: number;
  column?: number;
};

export type BrowserPreviewCaptureStatus =
  "idle" | "capturing" | "captured" | "failed";

export type BrowserPreviewCapture = {
  path: string;
  filename: string;
  width: number;
  height: number;
  createdAt: string;
  /** Optional asset URL for rendering the capture in UI (e.g. convertFileSrc). */
  src?: string;
};

export type BrowserPreview = {
  url: string;
  history: string[];
  historyIndex: number;
  device: BrowserPreviewDevice;
  consoleErrors: number;
  diagnostics: BrowserPreviewDiagnostic[];
  diagnosticsSupported: boolean;
  diagnosticsCaptured: boolean;
  captureStatus: BrowserPreviewCaptureStatus;
  captureError?: string;
  latestCapture?: BrowserPreviewCapture;
  status: BrowserPreviewStatus;
  verificationMessage: string;
  /** When true, the page is rendered by a native child webview over the host rect. */
  nativeHost?: boolean;
  title?: string;
};

export type BrowserHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
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

export type NotificationPermissionState =
  "granted" | "denied" | "prompt" | "prompt-with-rationale";

export type SystemAccessScopeId =
  | "desktop"
  | "documents"
  | "downloads"
  | "removable-volumes"
  | "full-disk";

export type SystemAccessStatus =
  "granted" | "denied" | "unavailable" | "unsupported";

export type SystemAccessScope = {
  id: SystemAccessScopeId;
  label: string;
  reason: string;
  status: SystemAccessStatus;
  path?: string;
  canPrompt: boolean;
  settingsUrl: string;
};

export type ProviderConnectionStatus =
  "not-configured" | "checking" | "connected" | "failed" | "disconnected";

export type ProviderId =
  "openai" | "anthropic" | "kimi" | "xai" | "cursor" | "gemini" | "opencode";

export type ProviderExecutionKind =
  "codex-cli" | "claude-code" | "kimi-acp" | "acp-cli" | "readiness-only";

export type ProviderCapabilities = {
  executionKind: ProviderExecutionKind;
  executable: boolean;
  supportsApprovals: boolean;
  supportsImages: boolean;
  supportsResume: boolean;
  supportsUsage: boolean;
  visibility: "standard" | "readiness-only";
};

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
  contextWindowTokens?: number;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: ReasoningEffort[];
};

export type ReasoningEffort =
  "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

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
  /**
   * When the provider itself last rejected the sign-in Gyro sent with.
   *
   * A CLI status command reports whether a login is stored, not whether it
   * still works: `claude auth status` answers `loggedIn: true` for a token the
   * API has already expired. A rejected send is the only proof Gyro gets, so it
   * is recorded here and outranks any later status probe until a sign-in
   * actually completes.
   */
  signInRejectedAt?: string;
  defaultModel: string;
  effort: "low" | "medium" | "high" | "extra-high";
  allowedTools: string[];
  approvalPolicy: "ask" | "allow";
};

export type HarnessRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type ProviderSessionStatus = "ready" | HarnessRunStatus;

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

export type ProviderResumeCursor = {
  kind: "codex-session" | "claude-session" | string;
  sessionId: string;
};

export type ProviderChatStreamPhase =
  | "started"
  | "activity"
  | "delta"
  /** Backend keep-alive while the provider process is quiet but still running. */
  | "heartbeat"
  | "completed"
  | "failed"
  | "cancelled";

export type ProviderChatStreamEvent = {
  sessionId: string;
  turnId?: string | null;
  providerId: string;
  modelId?: string | null;
  eventId: string;
  sequence: number;
  activitySequence?: number | null;
  phase: ProviderChatStreamPhase;
  status?: HarnessRunStatus | null;
  textDelta?: string | null;
  activityId?: string | null;
  activityKind?: string | null;
  activityLabel?: string | null;
  activityDetail?: string | null;
  /** Specifics behind a machine tool id — command, path, skill name, … */
  activityNote?: string | null;
  activityStatus?: "running" | "done" | "failed" | null;
  message?: string | null;
  error?: string | null;
  /** How a failed turn can be repaired, as classified by the backend. */
  recoveryKind?: string | null;
};

export type ProviderRunDiagnostics = {
  schema: "gyro.harness.v1";
  kind: "provider-diagnostics";
  runId: string;
  attemptId: string;
  providerId: string;
  modelId?: string | null;
  status: HarnessRunStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  retryCount: number;
  resumed: boolean;
  timeoutSeconds?: number | null;
  failureReason?: string | null;
  outputSummary?: string | null;
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
  content?: string;
  items: SessionPlanItem[];
  sourceTurnId?: string;
  providerId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ChatArtifactStatus =
  "streaming" | "ready" | "stale" | "failed" | "completed";

export type ChatArtifactKind =
  | "decision"
  | "command"
  | "completion"
  | "workspace"
  | "preview"
  | "table"
  | "diagram"
  | "memory";

export type ChatArtifactBase = {
  id: string;
  kind: ChatArtifactKind;
  title: string;
  status?: ChatArtifactStatus;
  sourceTurnId?: string;
  createdAt?: string;
};

export type ChatArtifactDecisionOption = {
  id: string;
  label: string;
  description?: string;
  prompt?: string;
  recommended?: boolean;
};

export type ChatArtifact =
  | {
      id: string;
      kind: "decision";
      title: string;
      status?: ChatArtifactStatus;
      summary?: string;
      options: ChatArtifactDecisionOption[];
    }
  | {
      id: string;
      kind: "command";
      title: string;
      status?: ChatArtifactStatus;
      command: string;
      purpose?: string;
      workingDirectory?: string;
      risk?: "low" | "review" | "high";
    }
  | {
      id: string;
      kind: "completion";
      title: string;
      status?: ChatArtifactStatus;
      summary: string;
      items?: Array<{
        label: string;
        status: "passed" | "failed" | "skipped" | "changed";
        detail?: string;
      }>;
      files?: string[];
    }
  | {
      id: string;
      kind: "workspace";
      title: string;
      status?: ChatArtifactStatus;
      files: Array<{ path: string; description?: string }>;
    }
  | {
      id: string;
      kind: "preview";
      title: string;
      status?: ChatArtifactStatus;
      url?: string;
      description?: string;
      /** Absolute path to a capture, if known. */
      capturePath?: string;
      /** Renderable image URL for the capture thumbnail. */
      captureUrl?: string;
    }
  | {
      id: string;
      kind: "table";
      title: string;
      status?: ChatArtifactStatus;
      columns: string[];
      rows: string[][];
    }
  | {
      id: string;
      kind: "diagram";
      title: string;
      status?: ChatArtifactStatus;
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ from: string; to: string; label?: string }>;
    }
  | {
      id: string;
      kind: "memory";
      title: string;
      status?: ChatArtifactStatus;
      operation: "save" | "edit" | "forget";
      content: string;
    };

export type OnboardingStepId =
  | "account"
  | "welcome"
  | "theme"
  | "system-access"
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
  modelFollow: ModelFollowMode;
  cliLaunchPreset: CliLaunchPreset;
  /**
   * Session ids that are missions (goal chats that own CLI workers). Phase 1
   * stores this client-side until the session store persists `kind`.
   */
  missionSessionIds: string[];
  /** Default command profile for new mission workers (e.g. same CLI × N). */
  missionDefaultProfileId?: string;
  usageProviderId?: ProviderId;
  usageVisualization: "bars" | "wheels";
  showMenuBarIcon: boolean;
  workspaceSidebarHidden: boolean;
  workspaceSidebarWidth?: number;
  workspacePanelHeight: number;
  /**
   * Preferred mode for new chats. Session storage and APIs still use
   * `local` | `worktree`; this only seeds drafts that have not set a mode yet.
   */
  defaultWorkspaceMode: WorkbenchMode;
  workspaceTrust: Record<string, WorkspaceTrustDecision>;
  workspaceFolders: Record<string, string[]>;
  workspaceUserSettings: WorkspaceScopedSettings;
  workspaceSettingsByWorkspace: Record<string, WorkspaceScopedSettings>;
  workspaceSettingsByFolder: Record<string, WorkspaceScopedSettings>;
  workspaceKeybindings: Record<string, WorkspaceKeybinding | null>;
};

export type WorkspaceTrustDecision = "trusted" | "restricted";

export type WorkspaceSettingScope = "user" | "workspace" | "folder";

export type WorkspaceScopedSettings = {
  filesExclude?: string[];
  searchExclude?: string[];
  searchMaxResults?: number;
  editorMinimapEnabled?: boolean;
};

export type WorkspaceKeybinding = {
  key: string;
  primary?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ProviderUsageWindow = {
  id: string;
  label: string;
  /**
   * How much of the window is spent, when the provider measures it.
   *
   * Codex reports a percentage. Claude Code names the window and its reset but
   * never how full it is, so an unmeasured window leaves this absent rather
   * than claiming a level it was never told.
   */
  usedPercent?: number;
  status?: "ok" | "warning" | "exhausted";
  resetsAt?: string;
};

export type ProviderUsageState = {
  providerId: ProviderId;
  status: "idle" | "loading" | "available" | "unavailable" | "error";
  windows: ProviderUsageWindow[];
  fetchedAt?: string;
  stale?: boolean;
  error?: string;
};

/**
 * What one action spent, as Gyro's own usage ledger recorded it.
 *
 * The ledger counts provider calls rather than user turns, because one turn can
 * be several calls: a Council turn is its seats plus a synthesis.
 */
export type UsageOrigin =
  | "chat"
  | "automation"
  | "council-seat"
  | "council-synthesis"
  | "council-resynthesis";

export type UsageOriginTotals = {
  origin: UsageOrigin;
  label: string;
  calls: number;
  totalTokens: number;
};

export type SessionUsageTotals = {
  calls: number;
  /** Calls whose tokens the provider reported. */
  measuredCalls: number;
  /** Calls Gyro estimated because the provider reports no counts. */
  estimatedCalls: number;
  inputTokens: number;
  /** The share of `inputTokens` that was context re-read rather than sent fresh. */
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byOrigin: UsageOriginTotals[];
  firstCallAt?: string;
  lastCallAt?: string;
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
  preview?: boolean;
  groupId?: string;
};

export type EditorPane = {
  id: string;
  path?: string;
};

export type EditorGroup = {
  id: string;
  title: string;
  activePath?: string;
  tabs: EditorTab[];
  panes: EditorPane[];
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

export type EditorRevealTarget = {
  path: string;
  lineNumber: number;
  column: number;
  nonce: number;
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
  /** Chat turn this request started, used to show its reply in the Workspace. */
  turnId?: string;
  sessionId?: string;
};

/** The reply to a Workspace-initiated assistant request, as it streams in. */
export type IdeAssistantReply = {
  turnId: string;
  text: string;
  status: WorkbenchTurnStatus;
};

export type IdeViewId =
  "explorer" | "search" | "source-control" | "run-test" | "ai" | "settings";

export type IdeLayoutState = {
  groups: EditorGroup[];
  activeGroupId: string;
  splitDirection: "right" | "down";
  minimapEnabled: boolean;
  restoreOnLaunch: boolean;
};

export type WorkspaceSearchQuery = {
  query: string;
  globs?: string[];
  maxResults?: number;
};

export type WorkspaceSearchResult = {
  path: string;
  lineNumber: number;
  line: string;
  ranges?: Array<{ startColumn: number; endColumn: number }>;
};

export type FileDecoration = {
  path: string;
  badge?: string;
  color?: "modified" | "added" | "deleted" | "warning" | "error";
  tooltip?: string;
};

export type ProblemSeverity = "error" | "warning" | "info" | "hint";

export type ProblemDiagnostic = {
  id: string;
  path: string;
  message: string;
  severity: ProblemSeverity;
  source?: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber?: number;
  endColumn?: number;
};

export type SourceControlResourceState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "staged";

export type SourceControlFile = {
  path: string;
  originalPath?: string;
  state: SourceControlResourceState;
  staged: boolean;
  additions: number;
  deletions: number;
};

export type SourceControlState = {
  provider: "git";
  available: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  repoRoot?: string;
  additions: number;
  deletions: number;
  statsPartial: boolean;
  files: SourceControlFile[];
  lastCheckedAt?: string;
  error?: string;
};

/**
 * Normalized state for a workflow run, job, step, or PR check rollup. Mirrors
 * `GithubRunState` in crates/gyro-core/src/github.rs.
 */
export type GithubRunState =
  | "queued"
  | "in-progress"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral"
  | "timed-out"
  | "action-required"
  | "stale"
  | "unknown";

export type GithubAvailability = {
  schema: string;
  /** gh installed, authenticated, and the workspace is a GitHub repository. */
  available: boolean;
  cliInstalled: boolean;
  authenticated: boolean;
  account?: string;
  host?: string;
  repository?: string;
  defaultBranch?: string;
  error?: string;
  hint?: string;
};

export type GithubWorkflowStep = {
  name: string;
  number: number;
  state: GithubRunState;
  conclusion?: string;
};

export type GithubWorkflowJob = {
  id: number;
  name: string;
  state: GithubRunState;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url: string;
  steps: GithubWorkflowStep[];
};

export type GithubWorkflowRun = {
  id: number;
  number: number;
  title: string;
  workflowName: string;
  state: GithubRunState;
  status: string;
  conclusion?: string;
  branch: string;
  sha: string;
  event: string;
  url: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GithubWorkflowRunDetail = {
  run: GithubWorkflowRun;
  jobs: GithubWorkflowJob[];
};

export type GithubPullRequest = {
  number: number;
  title: string;
  state: string;
  author?: string;
  headRef: string;
  baseRef: string;
  url: string;
  isDraft: boolean;
  checks?: GithubRunState;
  createdAt?: string;
  updatedAt?: string;
};

/** Workspace-scoped GitHub state held in the IDE slice. */
export type GithubState = {
  availability?: GithubAvailability;
  runs: GithubWorkflowRun[];
  selectedRunId?: number;
  runDetail?: GithubWorkflowRunDetail;
  runLogs?: string;
  pullRequests: GithubPullRequest[];
  loading: boolean;
  lastCheckedAt?: string;
  error?: string;
};

export type GitBranchCatalog = {
  available: boolean;
  current?: string;
  branches: string[];
  worktrees?: Array<{
    branch: string;
    path: string;
  }>;
  error?: string;
};

export type TaskDefinition = {
  id: string;
  label: string;
  command: string;
  args: string[];
  group: "build" | "test" | "dev" | "custom";
  cwd?: string;
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  lastRunAt?: string;
  outputChannelId?: string;
  /** "suggested" comes from project manifests, "custom" from saved commands. */
  source?: "suggested" | "custom";
};

/** A command the person typed into Run and Test to keep for this workspace. */
export type CustomTaskDraft = {
  commandLine: string;
  label?: string;
  group?: TaskDefinition["group"];
  cwd?: string;
};

export type TestTreeItem = {
  id: string;
  label: string;
  path?: string;
  status: "unknown" | "queued" | "running" | "passed" | "failed" | "skipped";
  children?: TestTreeItem[];
};

export type DebugSessionState = {
  id: string;
  name: string;
  adapter: string;
  status:
    "configured" | "starting" | "running" | "paused" | "stopped" | "failed";
  message?: string;
  capabilities?: string[];
  lastEvent?: string;
};

export type LanguageServerState = {
  id: string;
  serverId?: string;
  languageId: string;
  command: string;
  status:
    "starting" | "ready" | "not-installed" | "warning" | "error" | "stopped";
  message?: string;
  activePath?: string;
};

export type OutputChannel = {
  id: string;
  label: string;
  kind: "terminal" | "task" | "test" | "debug" | "lsp" | "ai" | "system";
  lines: string[];
  updatedAt?: string;
};

export type IdeCommand = {
  id: string;
  label: string;
  category: "file" | "edit" | "view" | "source-control" | "run" | "ai";
  viewId?: IdeViewId;
};

export type IdeContribution = {
  id: string;
  label: string;
  version: string;
  publisher: string;
  source: "core" | "local";
  enabled: boolean;
  permissions: Array<"commands" | "views" | "tasks" | "debug" | "languages">;
  manifestName?: string;
  views: IdeViewId[];
  commands: IdeCommand[];
};

export type IdeAiToolCall = {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "failed" | "blocked";
  summary: string;
  createdAt: string;
  finishedAt?: string;
};

/**
 * Where the model is currently working. Purely descriptive: recording a focus
 * never moves the user's viewport, so the chat thread stays put while the
 * ambient surfaces show what the model is touching.
 */
export type ModelFocus = {
  sessionId: string;
  kind: "ide" | "terminal" | "browser" | "output" | "proposal";
  label: string;
  detail?: string;
  path?: string;
  line?: number;
  column?: number;
  paneTab?: WorkbenchPaneTab;
  /** Terminal pane backing a "terminal" focus, so a peek can tail it. */
  paneId?: string;
  /** Capability resource id, used to find the matching output channel. */
  resourceId?: string;
  callId: string;
  updatedAt: string;
};

/**
 * How the app reacts when the model reveals where it is working.
 * - "off": ambient badges only.
 * - "peek": badges plus an inline strip that opens a transient peek.
 * - "follow": the legacy behaviour, where the app navigates along with it.
 */
export type ModelFollowMode = "off" | "peek" | "follow";

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
  activeView: IdeViewId;
  layout: IdeLayoutState;
  searchQuery: WorkspaceSearchQuery;
  searchResults: WorkspaceSearchResult[];
  fileDecorations: FileDecoration[];
  diagnostics: ProblemDiagnostic[];
  sourceControl: SourceControlState;
  taskDefinitions: TaskDefinition[];
  testTree: TestTreeItem[];
  debugSessions: DebugSessionState[];
  languageServers: LanguageServerState[];
  outputChannels: OutputChannel[];
  activeOutputChannelId?: string;
  contributions: IdeContribution[];
  aiToolCalls: IdeAiToolCall[];
  github: GithubState;
};

export type WorkbenchState = {
  activeDestination: AppDestination;
  activeWorkspaceLayout: WorkspaceLayoutId;
  lastSessionsLayout: SessionsLayoutId;
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
  modelFocus?: ModelFocus;
  modelFocusHistory: ModelFocus[];
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
  reasoningEffort?: ReasoningEffort;
  summary?: string;
  summaryUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  eventsPath: string;
  /**
   * Optional until the session store persists kind. Missions are also tracked in
   * `WorkbenchPreferences.missionSessionIds` for Phase 1.
   */
  kind?: SessionKind;
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
    | "goal-updated"
    | "chat-mode-changed"
    | "council-run-started"
    | "council-seat-started"
    | "council-seat-completed"
    | "council-seat-failed"
    | "council-synthesis-started"
    | "council-synthesis-completed"
    | "council-run-completed"
    | "council-run-cancelled"
    | "system-event";
  message: string;
  payload: unknown;
};

export type CouncilToolPolicy = "none";

export type CouncilRunStatus =
  | "queued"
  | "running"
  | "synthesizing"
  | "done"
  | "partial"
  | "failed"
  | "cancelled";

export type CouncilSeatStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type CouncilPreset = {
  id: string;
  name: string;
  description?: string;
  seatProviderIds: string[];
  seatModelIds?: Record<string, string | null>;
  synthesizerProviderId: string;
  synthesizerModelId?: string | null;
  toolPolicy: CouncilToolPolicy;
  builtIn?: boolean;
};

export type CouncilConfig = {
  defaultPresetId: string;
  presets: CouncilPreset[];
  maxSeats: number;
  seatTimeoutSeconds: number;
  synthesizerTimeoutSeconds: number;
  synthesizeOnPartial: boolean;
  enabled: boolean;
};

/**
 * Ceilings that stop spending nobody chose.
 *
 * Preflight covers the deliberate expensive send; these cover retry loops,
 * runaway turns, and schedules running while nobody is watching.
 */
export type UsageGuardConfig = {
  enabled: boolean;
  /** The current hold on provider runs, with its reason and expiry. */
  pause: PauseState;
  /** Per-provider spend caps measured against the ledger. */
  budgets: UsageBudget[];
  windowMinutes: number;
  maxCallsPerWindow: number;
  /** Lower than the overall ceiling: unattended spend is caught earlier. */
  maxUnattendedCallsPerWindow: number;
  /** Tokens one call may bill before it is stopped. Zero disables it. */
  maxTokensPerCall: number;
  maxResynthesesPerWindow: number;
};

/** Why Gyro is holding provider runs. A pause carries its provenance. */
export type PauseReason =
  | { kind: "manual" }
  | { kind: "budgetExhausted"; providerId: string };

/** What a pause covers. Automations can be stopped without stopping chat. */
export type PauseScope = "all" | "automations";

export type PauseState = {
  active: boolean;
  scope: PauseScope;
  reason?: PauseReason;
  since?: string;
  /** When the pause lifts by itself. Absent for a manual pause. */
  autoResumeAt?: string;
};

export type UsageBudget = {
  providerId: string;
  windowHours: number;
  /** Tokens allowed in the window. Zero means the budget is off. */
  maxTokens: number;
  notifyPercent: number;
  throttlePercent: number;
};

export type BudgetLevel = "ok" | "notify" | "throttle" | "exhausted";

export type BudgetState = {
  providerId: string;
  usedTokens: number;
  maxTokens: number;
  percent: number;
  level: BudgetLevel;
  windowHours: number;
  windowResetsAt: string;
  /** Whether any spend counted here was estimated rather than reported. */
  hasEstimates: boolean;
};

/**
 * What one provider has spent, measured by Gyro rather than reported by it.
 *
 * Windows match the plan meters providers actually use: a rolling 5-hour
 * session window and a weekly window — not an arbitrary calendar day.
 * Available for every provider, including those with no quota API.
 */
export type ProviderLedgerSummary = {
  providerId: string;
  /** Rolling 5 hours (same window as Claude/Codex session limits). */
  fiveHour: SessionUsageTotals;
  /** Rolling 7 days (same window as weekly plan limits). */
  week: SessionUsageTotals;
  /** Present only when a budget is configured for this provider. */
  budget?: BudgetState;
  /** Denominator for the percentages when no budget is configured (tokens / day). */
  dailyReferenceTokens: number;
};

/** The current hold and every configured budget, as the UI reads them. */
export type UsageSafetySnapshot = {
  pause: PauseState;
  budgets: BudgetState[];
};

export type CouncilAttachmentRef = {
  id: string;
  name?: string;
  path?: string;
  kind?: string;
};

export type CouncilContextSnapshot = {
  id: string;
  prompt: string;
  projectKey?: string;
  workspacePath?: string;
  attachments: CouncilAttachmentRef[];
  gitSummary?: string | null;
  createdAt: string;
};

export type CouncilSeat = {
  id: string;
  councilRunId: string;
  runId: string;
  providerId: string;
  providerLabel: string;
  modelId?: string | null;
  modelLabel?: string | null;
  status: CouncilSeatStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  rawOutput?: string;
  artifactPath?: string;
  error?: string | null;
  diagnostics?: ProviderRunDiagnostics | null;
};

export type CouncilDisagreementPosition = {
  seatId: string;
  seatLabel?: string;
  summary: string;
};

export type CouncilDisagreement = {
  topic: string;
  positions: CouncilDisagreementPosition[];
  recommendation?: string;
};

export type CouncilUniqueInsight = {
  seatId: string;
  seatLabel?: string;
  insight: string;
};

export type CouncilSynthesis = {
  synthesizerProviderId: string;
  synthesizerModelId?: string | null;
  synthesizerRunId?: string;
  unifiedMarkdown: string;
  recommendation: string;
  agreement: string[];
  disagreements: CouncilDisagreement[];
  uniqueInsights: CouncilUniqueInsight[];
  risksAndTests: string[];
  adoptionSteps: string[];
  parseWarnings?: string[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  userEditedMarkdown?: string | null;
  artifactPath?: string;
};

export type CouncilRunTotals = {
  wallDurationMs?: number;
  seatsSucceeded: number;
  seatsFailed: number;
  estimatedCostUsd?: number | null;
};

export type CouncilRun = {
  schema: "gyro.council.v1";
  id: string;
  sessionId: string;
  status: CouncilRunStatus;
  presetId?: string | null;
  snapshot: CouncilContextSnapshot;
  seats: CouncilSeat[];
  synthesis?: CouncilSynthesis | null;
  toolPolicy: CouncilToolPolicy;
  synthesizerProviderId?: string | null;
  synthesizerModelId?: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string | null;
  totals?: CouncilRunTotals;
};

/** Compact seat summary embedded in assistant `council-response` payloads. */
export type CouncilSeatSummary = {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId?: string | null;
  status: CouncilSeatStatus | string;
  durationMs?: number;
  error?: string | null;
  artifactPath?: string | null;
  outputPreview?: string | null;
};

export type CouncilResponsePayload = {
  kind: "council-response";
  councilRunId: string;
  status: CouncilRunStatus | string;
  presetId?: string | null;
  seats: CouncilSeatSummary[];
  synthesis?: CouncilSynthesis | null;
  totals?: CouncilRunTotals | null;
  manifestPath?: string | null;
  retry?: boolean;
};

export type CouncilActionRequest =
  | {
      type: "continue-as-run";
      markdown: string;
      councilRunId: string;
    }
  | {
      type: "promote-seat";
      councilRunId: string;
      seat: CouncilSeatSummary;
      fullText?: string;
    }
  | {
      type: "resynthesize";
      councilRunId: string;
      sessionId: string;
    }
  | {
      type: "load-seat";
      councilRunId: string;
      sessionId: string;
      seatId: string;
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
  /**
   * Model new sessions on this provider start with. Persisted, so it survives
   * restarts; `selectedModelId` tracks the live session instead and is rewritten
   * every time the active session changes.
   */
  defaultModelId?: string;
  selectedModelId?: string;
  selectedReasoningEffort?: ReasoningEffort;
  capabilities?: ProviderCapabilities;
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
  automaticUpdateChecks?: boolean;
  telemetryEnabled: boolean;
  requireCommandApproval: boolean;
  requireFileEditApproval: boolean;
  fullAccess?: boolean;
  accountOidc?: GyroAccountOidcConfig;
  accountSession?: GyroAccountSession;
  selectedProviderId?: ProviderId;
  modelProviders: ModelProviderConfig[];
  commandProfiles: CommandProfile[];
  council?: CouncilConfig;
  usageGuard?: UsageGuardConfig;
};

export type UpdateStatus =
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed"
  | "development";

export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  nextVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  progressPercent?: number;
  lastCheckedAt?: string;
  error?: string;
  retryable?: boolean;
  silentFailure?: boolean;
};

/** One provider CLI that Gyro can update (Claude, Codex, Grok, …). */
export type CliUpdateOffer = {
  providerId: string;
  displayName: string;
  program: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkSource: string;
  updateCommand: string[];
};

export type CliUpdateCheckReport = {
  checkedAt: string;
  offers: CliUpdateOffer[];
};

export type CliUpdateApplyResult = {
  providerId: string;
  displayName: string;
  ok: boolean;
  message: string;
};

export type CliUpdatePhase = "idle" | "checking" | "updating" | "failed";

export type CliUpdateNoticeState = {
  offers: CliUpdateOffer[];
  phase: CliUpdatePhase;
  error?: string;
  checkedAt?: string;
};

export type WorkspaceFile = {
  path: string;
  kind: "file" | "directory";
  depth?: number;
  workspacePath?: string;
  relativePath?: string;
  isWorkspaceRoot?: boolean;
};

export type GlobalSearchProject = {
  path: string;
  label: string;
  detail?: string;
  sessionCount?: number;
  current?: boolean;
};

export type GlobalSearchSelection =
  | { kind: "action"; id: string }
  | { kind: "file"; path: string }
  | { kind: "project"; path: string }
  | { kind: "session"; sessionId: string };

export type WorkspacePreparationPhase =
  "catalog" | "watcher" | "git" | "tasks" | "tests";

export type WorkspacePreparationStatus =
  "idle" | "preparing" | "ready" | "degraded" | "failed";

export type WorkspacePreparationError = {
  phase: WorkspacePreparationPhase;
  message: string;
};

export type WorkspacePreparationProgress = {
  runId: string;
  workspacePath: string;
  phase?: WorkspacePreparationPhase;
  status: WorkspacePreparationStatus;
  completedSteps: number;
  totalSteps: number;
  message: string;
  errors: WorkspacePreparationError[];
};

export type WorkspacePreparationSnapshot = WorkspacePreparationProgress & {
  files: WorkspaceFile[];
  sourceControl?: SourceControlState;
  branches?: GitBranchCatalog;
  tasks: TaskDefinition[];
  tests: TestTreeItem[];
  watcherMode: "event" | "polling";
  generation: number;
};

export type WorkspaceChangedEvent = {
  workspacePath: string;
  generation: number;
  files: WorkspaceFile[];
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
