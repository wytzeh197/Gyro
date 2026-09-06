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

const parameters = new URLSearchParams(location.search);
const scene = parameters.get("scene") ?? "chat";
const theme = parameters.get("theme") === "light" ? "light" : "dark";
const supportedScenes = new Set([
  "chat",
  "welcome",
  "active-chat",
  "companion-layout",
  "workspace-source-control",
  "workspace-diff",
  "selected-diff",
  "appearance",
  "cli",
  "ollama",
  "ollama-empty",
]);
if (!supportedScenes.has(scene)) {
  console.warn(`[capture] unknown scene: ${scene}`);
}
const isOllamaScene = scene === "ollama" || scene === "ollama-empty";
const isOllamaEmptyScene = scene === "ollama-empty";
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
  providerId: isOllamaScene ? "ollama" : "anthropic",
  providerLabel: isOllamaScene ? "Ollama" : "Claude Code",
  modelId: isOllamaScene
    ? isOllamaEmptyScene
      ? undefined
      : "qwen3-coder:30b"
    : "claude-opus-5",
  modelLabel: isOllamaScene
    ? isOllamaEmptyScene
      ? undefined
      : "Qwen3 Coder 30B"
    : "Claude Opus 5",
  reasoningEffort: isOllamaScene ? undefined : "high",
  createdAt: at(-18),
  updatedAt: at(0),
  eventsPath: `${WORKSPACE}/.gyro/events.jsonl`,
};

let sessions = [
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
let captureSessionSequence = 0;
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

/**
 * The normal capture transcript belongs to the seeded session above. A send
 * started from the welcome composer creates a different desktop session, so
 * its fixture events must retain that session and turn identity. Otherwise a
 * successful local capture is rendered against the wrong conversation.
 */
function captureSessionEvent(
  sessionId: string,
  turnId: string,
  kind: string,
  message: string,
  payload: Record<string, unknown> = {},
) {
  sequence += 1;
  return {
    id: `evt_capture_${sequence}`,
    sessionId,
    createdAt: at(0, sequence),
    turnId,
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

// The capture behaves like a small in-memory desktop store. A first message
// causes the UI to refresh that session's transcript while the response is
// arriving; returning an empty array there would erase the optimistic turn
// and make a successful capture look like a blank new chat.
const captureEventsBySessionId = new Map<
  string,
  Array<ReturnType<typeof sessionEvent>>
>([[SESSION_ID, chatEvents]]);

const config = {
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  fullAccess: false,
  selectedProviderId: isOllamaScene ? "ollama" : "anthropic",
  modelProviders: [
    {
      id: "anthropic",
      displayName: "Claude Code",
      apiKeyRef: "cli",
      enabled: true,
      authMode: "cli",
      authStatus: "connected",
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
      authStatus: "connected",
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
    ...(isOllamaScene
      ? [
          {
            id: "ollama",
            displayName: "Ollama",
            apiKeyRef: "local-runtime:ollama",
            enabled: true,
            authMode: "sdk",
            authStatus: "connected",
            baseUrl: "http://localhost:11434/api",
            defaultModelId: isOllamaEmptyScene ? undefined : "qwen3-coder:30b",
            selectedModelId: isOllamaEmptyScene ? undefined : "qwen3-coder:30b",
            models: isOllamaEmptyScene
              ? []
              : [
                  {
                    id: "qwen3-coder:30b",
                    displayName: "Qwen3 Coder 30B",
                    description: "Local coding model through Ollama.",
                    supportsTools: true,
                  },
                ],
            capabilities: {
              executionKind: "ollama-api",
              executable: true,
              supportsApprovals: true,
              supportsImages: false,
              supportsResume: true,
              supportsUsage: false,
              visibility: "standard",
            },
          },
        ]
      : []),
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

if (parameters.get("edge") === "lazy-explorer") {
  workspaceTree.push(
    file("node_modules", "directory", 1),
    file("node_modules/example", "directory", 2),
    file("node_modules/example/index.js", "file", 3),
    file("target", "directory", 1),
    file("target/build.log", "file", 2),
  );
  const controls = document.createElement("nav");
  controls.setAttribute("aria-label", "Explorer capture controls");
  controls.style.cssText =
    "position:fixed;right:16px;bottom:36px;z-index:99999";
  const toggle = document.createElement("button");
  toggle.textContent = "Add fixture file";
  toggle.onclick = () => {
    const path = `${WORKSPACE}/src/fixture-refresh.txt`;
    const index = workspaceTree.findIndex((entry) => entry.path === path);
    if (index < 0)
      workspaceTree.push(file("src/fixture-refresh.txt", "file", 2));
    else workspaceTree.splice(index, 1);
    toggle.textContent = index < 0 ? "Delete fixture file" : "Add fixture file";
  };
  controls.append(toggle);
  document.body.append(controls);
}

// Design QA cases remain isolated to the development capture entry point.
if (parameters.get("edge") === "multiple-roots") {
  const otherRoot = "/Users/dev/Clients/aurora";
  workspaceTree.push(
    {
      ...file("", "directory", 0),
      path: otherRoot,
      workspacePath: otherRoot,
      isWorkspaceRoot: true,
    },
    {
      ...file("README.md", "file", 1),
      path: `${otherRoot}/README.md`,
      workspacePath: otherRoot,
    },
    file(
      "a-very-long-workspace-file-name-with-important-details.ts",
      "file",
      1,
    ),
  );
}

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
  get_project_capability_policy: {
    schema: "gyro.capability.v1",
    workspaceKey: "aurora",
    revision: 1,
    classes: {
      "workspace-inspect": "allow",
      "workspace-sensitive-read": "ask",
      "ide-reveal": "allow",
      "terminal-execute": "ask",
      "terminal-observe": "allow",
      "browser-inspect": "allow",
      "browser-navigate": "ask",
    },
    grants: [],
    updatedAt: NOW,
  },
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
  check_system_access: [],
};

const emptyArray = new Set([
  "list_automations",
  "github_workflow_runs",
  "github_pull_requests",
]);

const emptyUsageTotals = {
  calls: 0,
  measuredCalls: 0,
  estimatedCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  byOrigin: [],
};

const invoke: Invoke = (command, args) => {
  if (parameters.get("edge") === "lazy-explorer") {
    const rootFiles = workspaceTree.filter(
      (entry) => entry.isWorkspaceRoot || entry.depth === 1,
    );
    if (command === "prepare_workspace")
      return { ...preparation, files: rootFiles };
    if (command === "watch_workspace") return rootFiles;
  }
  if (command === "list_workspace_tree" && args?.depth === 1) {
    const directory = String(args.workspacePath);
    return workspaceTree
      .filter(
        (entry) =>
          !entry.isWorkspaceRoot &&
          entry.path.slice(0, entry.path.lastIndexOf("/")) === directory,
      )
      .map((entry) => ({
        path: entry.path.slice(directory.length + 1),
        kind: entry.kind,
        depth: 1,
      }));
  }
  if (
    parameters.get("edge") === "multiple-roots" &&
    ["watch_workspace", "list_workspace_tree"].includes(command)
  ) {
    return workspaceTree.filter(
      (entry) =>
        entry.workspacePath === String(args?.workspacePath ?? WORKSPACE),
    );
  }
  if (command === "plugin:event|listen") {
    const id = Number(args?.handler);
    captureListeners.set(id, String(args?.event));
    return id;
  }
  if (command === "plugin:event|unlisten") {
    captureListeners.delete(Number(args?.eventId));
    return null;
  }
  if (command.startsWith("plugin:event|")) return 0;
  if (command === "warm_desktop_shell") {
    return {
      ready: true,
      sessionCount: sessions.length,
      providerCount: config.modelProviders.length,
      sessionPoolWarmed: 1,
      automationPoolWarmed: 1,
      elapsedMs: 0,
      integrity: "ok",
    };
  }
  if (command === "get_usage_safety_snapshot") {
    return { pause: { active: false, scope: "all" }, budgets: [] };
  }
  if (command === "list_sessions") {
    return sessions;
  }
  if (command === "delete_session") {
    const sessionId = String(args?.sessionId ?? "");
    const hadSession = sessions.some((item) => item.id === sessionId);
    sessions = sessions.filter((item) => item.id !== sessionId);
    captureEventsBySessionId.delete(sessionId);
    return hadSession;
  }
  if (command === "get_session_usage_totals") {
    return emptyUsageTotals;
  }
  if (command === "check_cli_updates_command") {
    return { offers: [] };
  }
  if (command === "read_session_events") {
    const sessionId = String(args?.sessionId ?? SESSION_ID);
    return {
      events: captureEventsBySessionId.get(sessionId) ?? [],
      hasMoreBefore: false,
    };
  }
  if (command === "create_desktop_session") {
    captureSessionSequence += 1;
    const created = {
      ...session,
      id: `ses_capture_send_${captureSessionSequence}`,
      title: String(args?.title ?? "New chat"),
      workspacePath: String(args?.workspacePath ?? WORKSPACE),
      providerId: String(args?.providerId ?? session.providerId),
      providerLabel: String(args?.providerLabel ?? session.providerLabel),
      modelId: String(args?.modelId ?? session.modelId),
      modelLabel: String(args?.modelLabel ?? session.modelLabel),
      reasoningEffort: String(
        args?.reasoningEffort ?? session.reasoningEffort ?? "high",
      ),
      createdAt: at(0, captureSessionSequence),
      updatedAt: at(0, captureSessionSequence),
      eventsPath: `${String(args?.workspacePath ?? WORKSPACE)}/.gyro/events.jsonl`,
    };
    // `refreshSessions()` runs immediately after creation in the real app.
    // Keep its capture response consistent with the just-created session.
    sessions = [created, ...sessions];
    captureEventsBySessionId.set(created.id, []);
    return created;
  }
  if (command === "append_user_message") {
    const request = args ?? {};
    const sessionId = String(request.sessionId ?? SESSION_ID);
    const event = captureSessionEvent(
      sessionId,
      String(request.turnId ?? "turn_capture"),
      "user-message",
      String(request.message ?? "Capture message"),
    );
    captureEventsBySessionId.set(sessionId, [
      ...(captureEventsBySessionId.get(sessionId) ?? []),
      event,
    ]);
    return event;
  }
  if (command === "set_session_model") {
    const sessionId = String(args?.sessionId ?? "");
    const current = sessions.find((item) => item.id === sessionId);
    if (!current) {
      throw new Error("capture session not found");
    }
    const updated = {
      ...current,
      providerId: String(args?.providerId ?? current.providerId),
      providerLabel: String(args?.providerLabel ?? current.providerLabel),
      modelId: String(args?.modelId ?? current.modelId),
      modelLabel: String(args?.modelLabel ?? current.modelLabel),
      reasoningEffort: String(
        args?.reasoningEffort ?? current.reasoningEffort ?? "high",
      ),
      updatedAt: at(0, sequence),
    };
    sessions = sessions.map((item) => (item.id === sessionId ? updated : item));
    return updated;
  }
  if (command === "summarize_file_changes") {
    return [];
  }
  if (command === "run_provider_chat") {
    const request =
      (args?.request as Record<string, unknown> | undefined) ?? {};
    const sessionId = String(request.sessionId ?? SESSION_ID);
    const turnId = String(request.turnId ?? "turn_capture");
    const providerLabel = String(request.providerLabel ?? "Claude Code");
    const modelLabel = String(request.modelLabel ?? "Claude Opus 5");
    const responseSession = sessions.find((item) => item.id === sessionId);
    // Manual steps make streaming placement and the completed review card
    // reproducible without a provider, a real edit, or timing-dependent waits.
    if (parameters.get("edge") === "live-file-changes") {
      return new Promise((resolve) => {
        const activityEvents: ReturnType<typeof captureSessionEvent>[] = [];
        const changes = [
          { path: "src/sync.js", additions: 24, deletions: 6 },
          { path: "src/sync.test.js", additions: 31, deletions: 0 },
          { path: "src/queue/backoff.js", additions: 18, deletions: 0 },
          { path: "src/sync.js", additions: 30, deletions: 7 },
        ];
        let step = 0;
        const controls = document.createElement("nav");
        controls.setAttribute("aria-label", "File change capture controls");
        controls.style.cssText =
          "position:fixed;top:8px;right:8px;z-index:99999;display:flex;gap:8px;background:#fff;padding:8px;border:1px solid #ddd;border-radius:8px";
        const next = document.createElement("button");
        next.textContent = "Report next file change";
        next.onclick = () => {
          const file = changes[step++];
          if (!file) return;
          const event = captureSessionEvent(
            sessionId,
            turnId,
            "system-event",
            `Edited ${file.path}`,
            {
              kind: "provider-activity",
              activityKind: "file",
              activityId: `edit-${step}`,
              status: "done",
              label: `Edited ${file.path}`,
              detail: file.path,
              ...file,
            },
          );
          activityEvents.push(event);
          captureEventsBySessionId.set(sessionId, [
            ...(captureEventsBySessionId.get(sessionId) ?? []),
            event,
          ]);
          for (const [id, name] of captureListeners) {
            if (name === "gyro://provider-capability-event")
              callbacks.get(id)?.({ event: name, id, payload: event });
          }
          next.disabled = step === changes.length;
        };
        const finish = document.createElement("button");
        finish.textContent = "Finish capture run";
        finish.onclick = () => {
          const statusEvent = captureSessionEvent(
            sessionId,
            turnId,
            "system-event",
            `${providerLabel} finished`,
            {
              kind: "provider-status",
              status: "completed",
              providerId: request.providerId ?? "anthropic",
              providerLabel,
              modelLabel,
            },
          );
          const assistantEvent = captureSessionEvent(
            sessionId,
            turnId,
            "assistant-message",
            "Updated the retry logic and its tests. This was a local capture fixture; no files were changed.",
          );
          captureEventsBySessionId.set(sessionId, [
            ...(captureEventsBySessionId.get(sessionId) ?? []),
            statusEvent,
            assistantEvent,
          ]);
          controls.remove();
          resolve({
            activityEvents,
            statusEvent,
            assistantEvent,
            session: responseSession ?? null,
          });
        };
        controls.append(next, finish);
        document.body.append(controls);
      });
    }
    const activityEvent = captureSessionEvent(
      sessionId,
      turnId,
      "system-event",
      "Reviewed the requested workspace context",
      {
        kind: "provider-activity",
        activityKind: "search",
        label: "Reviewed the requested workspace context",
        detail: "Capture fixture only; no provider is contacted.",
        status: "done",
      },
    );
    const statusEvent = captureSessionEvent(
      sessionId,
      turnId,
      "system-event",
      `${providerLabel} finished`,
      {
        kind: "provider-status",
        status: "completed",
        providerId: String(request.providerId ?? "anthropic"),
        providerLabel,
        modelLabel,
        startedAt: at(0),
        completedAt: at(0, 1),
        durationMs: 1,
      },
    );
    const assistantEvent = captureSessionEvent(
      sessionId,
      turnId,
      "assistant-message",
      "Capture response: I reviewed the requested workspace context. This is a local fixture response; no provider was contacted.",
    );
    captureEventsBySessionId.set(sessionId, [
      ...(captureEventsBySessionId.get(sessionId) ?? []),
      activityEvent,
      statusEvent,
      assistantEvent,
    ]);
    return {
      activityEvents: [activityEvent],
      assistantEvent,
      session: responseSession ?? null,
      statusEvent,
    };
  }
  if (command === "get_provider_usage_ledger") {
    const providerId = String(args?.providerId ?? "anthropic");
    return {
      providerId,
      fiveHour: emptyUsageTotals,
      week: emptyUsageTotals,
      dailyReferenceTokens: 200_000,
    };
  }
  if (command === "discover_ollama_models_command") {
    return {
      baseUrl: String(args?.baseUrl ?? "http://localhost:11434/api"),
      models: isOllamaEmptyScene
        ? []
        : [
            {
              id: "qwen3-coder:30b",
              displayName: "Qwen3 Coder 30B",
              description: "Local coding model through Ollama.",
              contextWindowTokens: undefined,
              supportsTools: true,
            },
          ],
    };
  }
  if (command === "check_provider_health") {
    const providerId = String(
      (args?.request as { providerId?: string } | undefined)?.providerId ?? "",
    );
    if (providerId === "ollama" && isOllamaEmptyScene) {
      return {
        providerId,
        output:
          "Ollama is running, but no models are installed. Run `ollama pull <model>` and refresh Gyro.",
        runtimeStatus: "no-models",
        authOwner: "provider-sdk",
        authCommand: null,
        loginCommand: null,
        accountLabel: null,
        subscriptionLabel: null,
        providerMode: "local Ollama runtime",
        secretStorage:
          "No credentials; Ollama is contacted only over loopback.",
        privacyNote:
          "Gyro sends prompts only to the configured loopback Ollama runtime.",
        diagnosticsOptIn: false,
      };
    }
    return {
      providerId,
      output: `${providerId || "Provider"} capture fixture is ready.`,
      runtimeStatus: "ready",
      authOwner: providerId === "ollama" ? "provider-sdk" : "provider-cli",
      authCommand: null,
      loginCommand: null,
      accountLabel: null,
      subscriptionLabel: null,
      providerMode: providerId === "ollama" ? "local Ollama runtime" : null,
      secretStorage:
        providerId === "ollama"
          ? "No credentials; Ollama is contacted only over loopback."
          : "Provider CLI, OS Keychain, or provider-owned files.",
      privacyNote: "Capture fixture only; no provider is contacted.",
      diagnosticsOptIn: false,
    };
  }
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
const captureListeners = new Map<number, string>();
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

// Tauri v2 keeps event-listener cleanup on a separate global. The normal
// internals object above handles command callbacks; this companion prevents
// React effect cleanup from throwing in the browser-only capture harness.
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
  value: {
    unregisterListener(_event: string, id: number) {
      captureListeners.delete(id);
      callbacks.delete(id);
    },
  },
  configurable: true,
});

document.documentElement.dataset.captureScene = scene;
/*
 * The harness owns the theme so a scene is reproducible no matter what the
 * profile carries. Dark is the default because most scenes are shot dark; the
 * light hero passes ?theme=light.
 */
localStorage.setItem("gyro.theme", theme);
// A repeatable starting point for the chat/panel layout comparison. This entry
// point is development-only and its browser profile contains fixture data.
if (scene === "companion-layout") {
  localStorage.setItem(
    "gyro.workbench-state",
    JSON.stringify({
      preferences: {
        theme,
        density: parameters.get("density") ?? "compact",
        ...(parameters.get("edge") === "multiple-roots"
          ? { workspaceFolders: { [WORKSPACE]: ["/Users/dev/Clients/aurora"] } }
          : {}),
      },
      ...(parameters.get("edge") === "pending-review"
        ? {
            diffReview: {
              files: [
                {
                  path: "src/sync.js",
                  additions: 1,
                  deletions: 1,
                  source: "agent-generated",
                  state: "pending",
                  comments: 0,
                  lines: [
                    {
                      kind: "removed",
                      content: "const MAX_ATTEMPTS = Infinity;",
                      number: 3,
                    },
                    {
                      kind: "added",
                      content: "const MAX_ATTEMPTS = 5;",
                      number: 3,
                    },
                  ],
                },
              ],
              selectedPath: "src/sync.js",
              approvalState: "pending",
              commitMessage: "",
              collapsedDirectories: [],
              lastAction: "Fixture edit awaiting approval",
            },
          }
        : {}),
      lastSessionsLayout: "thread",
      isToolPanelOpen: false,
    }),
  );
}
