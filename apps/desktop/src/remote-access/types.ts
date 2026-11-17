import type {
  Session,
  SessionEvent,
  ProviderChatStreamEvent,
  ProviderModel,
  ProviderUsageState,
  SessionUsageTotals,
  SourceControlState,
  WorkspaceFile,
  WorkspaceFileContent,
} from "@gyro-dev/ui";
export type Peer = {
  id: string;
  name: string;
  role: "host" | "client" | "both";
  transport?: "ssh";
};
export type Project = { id: string; name: string; path: string };
export type Control = {
  owner: string;
  generation: number;
  requestedBy?: string | null;
};
export type SshOptions = {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  socketPath?: string;
};
export type SshHost = {
  id: string;
  name: string;
  options: SshOptions;
  connected: boolean;
};
export type AccessStatus = {
  activity?: Array<{ id: number; peerId: string; action: string; sessionId: string; at: number; ok: boolean; count: number }>;
  sshHosts?: SshHost[];
  sshClientId?: string;
  sshHostingActive?: boolean;
  hostingActive?: boolean;
  invitationActive?: boolean;
  settings: { enabled: boolean; name: string };
  deviceId?: string | null;
  peers: Peer[];
  pending: Peer[];
  projects: Project[];
  controls: Record<string, Control>;
};
export type ModelChoice = {
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
};
export type HostInfo = {
  protocol: number;
  hostId: string;
  name: string;
  experimental: boolean;
  capabilities: string[];
  selectedProviderId?: string;
  fullAccess?: boolean;
  requireCommandApproval?: boolean;
  requireFileEditApproval?: boolean;
  providers: Array<{
    id: string;
    displayName: string;
    defaultModelId?: string;
    models: string[];
    /** Optional on older hosts; IDs above remain the selectable inventory. */
    modelDetails?: ProviderModel[];
    kind?: string;
    runtimeStatus: string;
  }>;
};
export type History = {
  events: SessionEvent[];
  hasMoreBefore: boolean;
  revision?: string;
  unchanged: boolean;
};
export type Snapshot = {
  liveEvents?: ProviderChatStreamEvent[];
  liveCheckpoint?: boolean;
  liveTruncated?: boolean;
  providerUsage?: ProviderUsageState;
  sessionUsage?: SessionUsageTotals;
  session: Session;
  running: boolean;
  control?: Control;
  approvals: Array<{
    id: string;
    turnId?: string;
    kind: "provider" | "capability";
    payload?: Record<string, unknown>;
  }>;
  /** Pending file-edit proposals as the host stores them. */
  mutations: Array<{
    patch?: string;
    previewError?: string;
    id: string;
    path?: string;
    operation?: "create" | "update";
    /** Proposed full file content. */
    content?: string;
    baseExists?: boolean;
    beforeContent?: string;
    afterContent?: string;
  }>;
};
export type GitAction =
  | "status"
  | "diff"
  | "branches"
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "createBranch"
  | "checkout"
  | "fetch"
  | "pull"
  | "push";
export type TerminalAction =
  "list" | "create" | "read" | "input" | "resize" | "close";
export type HostOperation =
  | { op: "requestStatus"; requestId: string }
  | { op: "hello" | "projects" }
  | { op: "sessions"; projectId: string }
  | {
      op: "createSession";
      projectId: string;
      title: string;
      model: ModelChoice;
      branch?: string;
    }
  | { op: "renameSession"; sessionId: string; title: string }
  | { op: "setModel"; sessionId: string; model: ModelChoice }
  | { op: "attachWorkspaceFile"; sessionId: string; path: string }
  | { op: "history"; sessionId: string; before?: string; revision?: string }
  | { op: "snapshot"; sessionId: string; includeLiveEvents?: boolean }
  | {
      op: "watch" | "claim" | "release" | "requestControl" | "stop" | "files";
      sessionId: string;
    }
  | { op: "transferControl"; sessionId: string; peerId: string }
  | {
      op: "submit";
      sessionId: string;
      turnId: string;
      message: string;
      model: ModelChoice;
      attachments?: Array<{ path: string; kind: string; name: string; contentHash: string }>;
      mode?: "normal" | "plan";
    }
  | {
      op: "approval";
      sessionId: string;
      approvalId: string;
      turnId?: string;
      kind: "provider" | "capability" | "mutation";
      decision: "approve" | "reject";
    }
  | { op: "question"; sessionId: string; questionId: string; answers: unknown }
  | { op: "search"; sessionId: string; query: string }
  | { op: "readFile"; sessionId: string; path: string }
  | { op: "readImage"; sessionId: string; path: string; offset: number }
  | {
      op: "writeFile";
      sessionId: string;
      path: string;
      content: string;
      expectedHash?: string;
    }
  | {
      op: "path";
      sessionId: string;
      path: string;
      action: "createFile" | "createDirectory" | "rename" | "delete";
      name?: string;
      expectedHash?: string;
    }
  | {
      op: "git";
      sessionId: string;
      action: GitAction;
      path?: string;
      message?: string;
      expectedRevision?: string;
    }
  | {
      op: "terminal";
      sessionId: string;
      action: TerminalAction;
      paneId?: string;
      input?: string;
      cols?: number;
      rows?: number;
      revision?: number;
    };
export type HostEvent = {
  sessionId: string;
  topic: "provider" | "refresh" | "resync" | "checkpoint" | "terminal";
  payload: Record<string, unknown> | null;
};
export type HostRequest = {
  id: string;
  operation: HostOperation;
  lease?: number;
};
export type GitSnapshot = { status: SourceControlState; revision: string };
export type TerminalSnapshot = {
  outputCursor?: { generation: string; start: number; end: number };
  paneId: string;
  title: string;
  output?: string;
  outputRevision: number;
  outputComplete: boolean;
  status: "running" | "done" | "failed";
  cols: number;
  rows: number;
  exitCode?: number;
  workspacePath?: string;
};
export type FileBuffer = { file: WorkspaceFileContent; text: string };
export type WorkspaceData = {
  info?: HostInfo;
  projects: Project[];
  sessions: Session[];
  files: WorkspaceFile[];
  snapshot?: Snapshot;
  history?: History;
  git?: GitSnapshot;
  terminals: TerminalSnapshot[];
};
