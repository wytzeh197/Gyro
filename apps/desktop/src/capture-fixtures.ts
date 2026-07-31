/**
 * Screenshot capture harness.
 *
 * Installs a fake Tauri IPC layer so the real Gyro UI renders populated demo
 * content in a plain browser. This is a development tool for producing the
 * marketing screenshots under `site/assets/screenshots/`; it is never part of
 * the shipped app because `vite build` only takes `index.html` as an entry.
 *
 * Run `node scripts/capture-site-screenshots.mjs` rather than loading
 * `capture.html` by hand.
 *
 * Every value below is invented demo content. Nothing here reads a real
 * session, repository, or provider account.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => unknown;

const scene = new URLSearchParams(location.search).get("scene") ?? "chat";
const WORKSPACE = "/Users/dev/Projects/aurora";
const SESSION_ID = "ses_capture_1";
const NOW = "2026-07-25T09:41:00.000Z";

function at(minutes: number, seconds = 0) {
  const base = Date.parse(NOW);
  return new Date(base + minutes * 60_000 + seconds * 1000).toISOString();
}

const session = {
  id: SESSION_ID,
  title: "Bound the sync queue retries",
  workspacePath: WORKSPACE,
  origin: "desktop",
  workspaceMode: "chat",
  branch: "main",
  providerId: "anthropic",
  providerLabel: "Claude Code",
  modelId: "claude-opus-5",
  modelLabel: "Claude Opus 5",
  reasoningEffort: "high",
  createdAt: at(-18),
  updatedAt: at(0),
  eventsPath: `${WORKSPACE}/.gyro/events.jsonl`,
};

const sessions = [
  session,
  {
    ...session,
    id: "ses_capture_2",
    title: "Fix flaky editor file tree",
    providerLabel: "Codex CLI",
    providerId: "openai",
    modelLabel: "GPT-5.6",
    createdAt: at(-260),
    updatedAt: at(-240),
  },
  {
    ...session,
    id: "ses_capture_3",
    title: "Audit provider argument contracts",
    providerLabel: "Gemini CLI",
    providerId: "gemini",
    modelLabel: "Gemini 3 Pro",
    createdAt: at(-700),
    updatedAt: at(-680),
  },
];

let sequence = 0;
function sessionEvent(
  kind: string,
  message: string,
  payload: Record<string, unknown> = {},
  minutes = 0,
) {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sessionId: SESSION_ID,
    createdAt: at(minutes, sequence),
    turnId: "turn_1",
    kind,
    message,
    payload: { timelineSequence: sequence, ...payload },
  };
}

/** A `system-event` carrying a provider activity row in the transcript. */
function activity(
  activityKind: "command" | "search" | "tool" | "file",
  label: string,
  detail?: string,
  minutes = 0,
) {
  return sessionEvent(
    "system-event",
    label,
    { kind: "provider-activity", activityKind, label, detail, status: "done" },
    minutes,
  );
}

const chatEvents = [
  sessionEvent(
    "user-message",
    "The sync queue retries forever when the server returns 503. Add a bounded retry with backoff, and cover it with a test.",
    {},
    -18,
  ),
  sessionEvent(
    "system-event",
    "Claude Code finished",
    {
      kind: "provider-status",
      status: "completed",
      providerId: "anthropic",
      providerLabel: "Claude Code",
      modelLabel: "Claude Opus 5",
      startedAt: at(-18),
      completedAt: at(-12),
      durationMs: 342_000,
    },
    -12,
  ),
  sessionEvent(
    "assistant-message",
    "`drain()` loops on failure with no ceiling, so a 503 spins forever. I'll cap it at 5 attempts with exponential backoff and surface the last error instead of swallowing it.",
    {},
    -16,
  ),
  activity("search", "Searched for retry", "sync.js, queue/*.js", -16),
  activity("command", "npm test -- sync.test.js", "2 passed in 1.42s", -14),
  sessionEvent(
    "assistant-message",
    "Done. `drain()` stops after 5 attempts and backs off between them, and both cases are covered.",
    {},
    -12,
  ),
  // For file activity the `detail` field carries the path; the additions and
  // deletions are matched out of the source-control fixture by that path.
  activity("file", "Edited src/sync.js", "src/sync.js", -12),
  activity("file", "Edited src/sync.test.js", "src/sync.test.js", -12),
  activity("file", "Edited src/queue/backoff.js", "src/queue/backoff.js", -12),
];

const config = {
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  fullAccess: false,
  selectedProviderId: "anthropic",
  modelProviders: [
    {
      id: "anthropic",
      displayName: "Claude Code",
      apiKeyRef: "cli",
      enabled: true,
      authMode: "cli",
      authStatus: "ready",
      defaultModelId: "claude-opus-5",
      selectedModelId: "claude-opus-5",
      selectedReasoningEffort: "high",
      models: [
        { id: "claude-opus-5", displayName: "Claude Opus 5" },
        { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      ],
      capabilities: {
        executionKind: "claude-code",
        executable: true,
        supportsApprovals: true,
        supportsImages: true,
        supportsResume: true,
        supportsUsage: true,
        visibility: "standard",
      },
    },
    {
      id: "openai",
      displayName: "Codex CLI",
      apiKeyRef: "cli",
      enabled: true,
      authMode: "cli",
      authStatus: "ready",
      defaultModelId: "gpt-5.6",
      models: [{ id: "gpt-5.6", displayName: "GPT-5.6" }],
      capabilities: {
        executionKind: "codex-cli",
        executable: true,
        supportsApprovals: true,
        supportsImages: true,
        supportsResume: true,
        supportsUsage: true,
        visibility: "standard",
      },
    },
  ],
  commandProfiles: [
    {
      id: "shell",
      displayName: "Shell",
      command: "zsh",
      args: ["-l"],
      readiness: "ready",
    },
    {
      id: "claude",
      displayName: "Claude Code",
      command: "claude",
      args: [],
      providerId: "anthropic",
      readiness: "ready",
    },
  ],
};

/**
 * A mixed working tree: staged and unstaged sides, several languages, and a
 * deletion, so the Source Control groups and their colours all show up in a
 * capture.
 */
const changedFiles = [
  {
    path: "src/sync.js",
    state: "modified",
    staged: true,
    additions: 24,
    deletions: 6,
  },
  {
    path: "src/legacy/retry.js",
    state: "deleted",
    staged: true,
    additions: 0,
    deletions: 41,
  },
  {
    path: "src/sync.js",
    state: "modified",
    staged: false,
    additions: 24,
    deletions: 6,
  },
  {
    path: "src/sync.test.js",
    state: "added",
    staged: false,
    additions: 31,
    deletions: 0,
  },
  {
    path: "src/queue/backoff.js",
    state: "added",
    staged: false,
    additions: 18,
    deletions: 0,
  },
  {
    path: "src/app.tsx",
    state: "modified",
    staged: false,
    additions: 9,
    deletions: 2,
  },
  {
    path: "src/theme.css",
    state: "modified",
    staged: false,
    additions: 12,
    deletions: 3,
  },
  {
    path: "package.json",
    state: "modified",
    staged: false,
    additions: 2,
    deletions: 0,
  },
  {
    path: "docs/notes.md",
    state: "untracked",
    staged: false,
    additions: 15,
    deletions: 0,
  },
];

const sourceControl = {
  provider: "git",
  available: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  repoRoot: WORKSPACE,
  additions: 73,
  deletions: 6,
  statsPartial: false,
  files: changedFiles,
  lastCheckedAt: NOW,
};

const syncSource = `import { backoff, delay } from "./queue/backoff.js";

const MAX_ATTEMPTS = 5;

export class SyncQueue {
  constructor(transport) {
    this.transport = transport;
    this.pending = [];
  }

  enqueue(job) {
    this.pending.push(job);
  }

  async drain() {
    while (this.pending.length) {
      const job = this.pending[0];
      let attempt = 0;
      while (attempt < MAX_ATTEMPTS) {
        try {
          await this.send(job);
          this.pending.shift();
          break;
        } catch (error) {
          attempt += 1;
          if (attempt >= MAX_ATTEMPTS) throw error;
          await delay(backoff(attempt));
        }
      }
    }
  }

  send(job) {
    return this.transport.post("/sync", job);
  }
}
`;

const diff = `diff --git a/src/sync.js b/src/sync.js
--- a/src/sync.js
+++ b/src/sync.js
@@ -12,9 +12,21 @@ export class SyncQueue {
   async drain() {
-    while (this.pending.length) {
-      const job = this.pending[0];
-      try {
-        await this.send(job);
-        this.pending.shift();
-      } catch (error) {
-        continue;
-      }
+    while (this.pending.length) {
+      const job = this.pending[0];
+      let attempt = 0;
+      while (attempt < MAX_ATTEMPTS) {
+        try {
+          await this.send(job);
+          this.pending.shift();
+          break;
+        } catch (error) {
+          attempt += 1;
+          if (attempt >= MAX_ATTEMPTS) throw error;
+          await delay(backoff(attempt));
+        }
+      }
     }
   }
`;

function file(relativePath: string, kind: "file" | "directory", depth: number) {
  return {
    path: `${WORKSPACE}/${relativePath}`,
    kind,
    depth,
    workspacePath: WORKSPACE,
    relativePath,
    isWorkspaceRoot: false,
  };
}

const workspaceTree = [
  { ...file("", "directory", 0), path: WORKSPACE, isWorkspaceRoot: true },
  file("src", "directory", 1),
  file("src/queue", "directory", 2),
  file("src/queue/backoff.js", "file", 3),
  file("src/sync.js", "file", 2),
  file("src/sync.test.js", "file", 2),
  file("src/index.js", "file", 2),
  file("package.json", "file", 1),
  file("README.md", "file", 1),
];

const terminalOutput = [
  "$ gyro doctor",
  "workspace store ready",
  "CLI attach socket ready",
  "approvals required",
  "",
  "$ npm test -- sync.test.js",
  "",
  "PASS  src/sync.test.js",
  "  ✓ stops after 5 attempts (128 ms)",
  "  ✓ backs off exponentially (12 ms)",
  "",
  "Tests:       2 passed, 2 total",
  "Time:        1.42 s",
  "",
  "$ git status --short",
  " M src/sync.js",
  "?? src/queue/backoff.js",
  "?? src/sync.test.js",
  "",
  "$ gyro approvals --pending",
  "1 pending approval",
  "  npm test -- sync.test.js   claude · main",
  "",
  "$ gyro sessions",
  "ses_1  Bound the sync queue retries      claude   31h",
  "ses_2  Fix flaky editor file tree        codex    35h",
  "ses_3  Audit provider argument contracts gemini   43h",
  "",
  "$ ",
].join("\r\n");

const governedOutput = [
  "Claude Code v2.1.159",
  "~/Projects/aurora · main",
  "",
  "> bound the retry loop in the sync queue",
  "",
  "● Reading src/sync.js",
  "● Editing src/sync.js",
  "● Running npm test -- sync.test.js",
  "",
  "  Gyro approval required",
  "  npm test -- sync.test.js",
  "  [a] approve   [r] reject   [d] diff",
  "",
  "● Edited src/sync.js          +24 -6",
  "● Edited src/sync.test.js     +31",
  "● Edited src/queue/backoff.js +18",
  "",
  "  2 passed in 1.42s",
  "",
  "> ",
].join("\r\n");

const terminalPanes = [
  {
    paneId: "pane_shell",
    title: "Shell",
    profileId: "shell",
    command: "zsh -l",
    output: terminalOutput,
    outputRevision: 1,
    status: "done",
    hasForegroundJob: false,
    exitCode: 0,
    workspacePath: WORKSPACE,
    workingDirectory: WORKSPACE,
    cols: 96,
    rows: 28,
  },
  {
    paneId: "pane_claude",
    title: "Claude Code",
    profileId: "claude",
    command: "claude",
    output: governedOutput,
    outputRevision: 1,
    status: "running",
    hasForegroundJob: true,
    exitCode: null,
    workspacePath: WORKSPACE,
    workingDirectory: WORKSPACE,
    cols: 96,
    rows: 28,
    governedSessionId: SESSION_ID,
    governedProviderId: "anthropic",
  },
];

// `GitBranchCatalog.branches` is a list of names — the picker renders each
// entry directly, so objects here crash the branch menu.
const branches = {
  available: true,
  current: "main",
  branches: ["main", "sync-retry-guard"],
  worktrees: [],
};

const preparation = {
  runId: "prep_1",
  workspacePath: WORKSPACE,
  phase: "ready",
  status: "ready",
  completedSteps: 4,
  totalSteps: 4,
  message: "Workspace ready",
  errors: [],
  files: workspaceTree,
  sourceControl,
  branches,
  tasks: [],
  tests: [],
  watcherMode: "event",
  generation: 1,
};

const responses: Record<string, unknown> = {
  load_config: config,
  list_sessions: sessions,
  read_session_events: chatEvents,
  git_status: sourceControl,
  // Staging commands answer with the status the app re-renders from, so the
  // harness keeps showing a populated panel instead of emptying it.
  git_stage: sourceControl,
  git_unstage: sourceControl,
  git_discard: sourceControl,
  git_diff: { stdout: diff, stderr: "", exitCode: 0 },
  git_branches: branches,
  list_workspace_tree: workspaceTree,
  watch_workspace: workspaceTree,
  search_workspace: [
    {
      path: "src/sync.js",
      lineNumber: 12,
      line: "  async drain() {",
      ranges: [{ startColumn: 9, endColumn: 14 }],
    },
    {
      path: "src/queue/backoff.js",
      lineNumber: 3,
      line: "export function backoff(attempt) {",
      ranges: [{ startColumn: 17, endColumn: 24 }],
    },
  ],
  prepare_workspace: preparation,
  restore_terminal_panes: scene === "cli" ? terminalPanes : [],
  create_terminal_pane: terminalPanes[0],
  task_discover: [],
  test_discover: [],
  github_status: { available: false },
  get_provider_usage: { providerId: "anthropic", windows: [], fetchedAt: NOW },
  get_notification_permission: "granted",
  get_project_capability_policy: { commands: "ask", fileEdits: "ask" },
  update_capability_ide_evidence: null,
  set_menu_bar_snapshot: null,
  set_menu_bar_visible: null,
  append_editor_event: null,
  append_chat_context_event: null,
  lsp_start: {
    serverId: "none",
    languageId: "javascript",
    command: "",
    status: "stopped",
  },
  lsp_stop: null,
  lsp_request: null,
  check_browser_preview: { available: false },
};

const emptyArray = new Set([
  "list_automations",
  "github_workflow_runs",
  "github_pull_requests",
]);

const invoke: Invoke = (command, args) => {
  if (command.startsWith("plugin:event|")) return 0;
  if (command in responses) return responses[command];
  if (emptyArray.has(command)) return [];
  if (command === "read_terminal_output") {
    return (
      terminalPanes.find((pane) => pane.paneId === args?.paneId) ??
      terminalPanes[0]
    );
  }
  if (
    command === "read_workspace_file_full" ||
    command === "read_workspace_file"
  ) {
    return {
      path: String(args?.path ?? `${WORKSPACE}/src/sync.js`),
      content: syncSource,
      truncated: false,
      sizeBytes: syncSource.length,
      contentHash: "capture",
    };
  }
  if (command === "stat_workspace_file") {
    return {
      path: String(args?.path ?? `${WORKSPACE}/src/sync.js`),
      kind: "file",
      sizeBytes: syncSource.length,
      contentHash: "capture",
    };
  }
  missing.add(command);
  console.info(`[capture] unstubbed command: ${command}`, args);
  return null;
};

/** The capture script reads this to report commands that still need fixtures. */
const missing = new Set<string>();
(window as unknown as { __captureMissing: () => string[] }).__captureMissing =
  () => [...missing];

const callbacks = new Map<number, (payload: unknown) => void>();
let callbackId = 0;

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {
    invoke: (command: string, args?: Record<string, unknown>) =>
      Promise.resolve(invoke(command, args)),
    transformCallback(callback: (payload: unknown) => void) {
      callbackId += 1;
      callbacks.set(callbackId, callback);
      return callbackId;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label: "main" } },
  },
  configurable: true,
});

document.documentElement.dataset.captureScene = scene;
localStorage.setItem("gyro.theme", "dark");
