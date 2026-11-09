import { CloudSettings } from "../../../packages/ui/src/cloud-settings";
import type { BillingSnapshot } from "../../../packages/ui/src/billing-settings";
// Development-only visual fixture. Production components, invented local data.
// No desktop IPC, providers, filesystem access, or external browser navigation.
// ?tool=review|files|browser|canvas|terminal|agents|side-chat|plan|closed|tools
// &theme=dark|light &split=1 &state=empty|failed|streaming|loading|issues
// &review=proposed opts into the separate proposed-file review fixture.
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  ChatGridSurface,
  ChatSurface,
  activeChatCompanionPanel,
  applyAppearancePreferences,
  chatCompanionPane,
  chatCompanionReducer,
  chatGridReducer,
  closeSubagentTab,
  createChatProjectLayout,
  createInitialChatCompanionState,
  isChatCompanionTabId,
  openSubagentTab,
  providersForConfig,
  terminalDefaultProfiles,
  type AppDestination,
  type BrowserPreview,
  type ChatCompanionTabId,
  type ChatGridState,
  type ChatPaneRef,
  type ChatSidePanelId,
  type DiffReview,
  type GyroConfig,
  type Session,
  type SessionEvent,
  type SessionPlan,
  type SideChatMessage,
  type SourceControlState,
  type SubagentSnapshot,
  type SubagentTabState,
  type TerminalPane,
  type WorkspaceFile,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
const sampleState = query.get("state") ?? "ready";
const requestedTool = query.get("tool") ?? "review";
const workspace = "/fixture/aurora";
const stamp = "2026-10-30T09:41:00.000Z";
const title = "Bound the sync queue retries";
const previewUrl = new URL(
  "companion-polish-fixture.html?page=preview",
  location.href,
).href;
const emptyConfig: GyroConfig = {
  modelProviders: [],
  commandProfiles: [],
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: "anthropic",
  modelProviders: providersForConfig(emptyConfig).map((provider) =>
    provider.id === "anthropic"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};
const paths = ["src/sync.ts", "src/sync.test.ts", "src/queue/backoff.ts"];
const counts = [
  { additions: 18, deletions: 4 },
  { additions: 12, deletions: 0 },
  { additions: 6, deletions: 2 },
];
const unified = [
  "diff --git a/src/sync.ts b/src/sync.ts",
  "--- a/src/sync.ts",
  "+++ b/src/sync.ts",
  "@@ -1,10 +1,14 @@",
  " import { sleep } from './queue/backoff';",
  " ",
  "+const MAX_ATTEMPTS = 5;",
  " ",
  " export async function drain(queue: Queue) {",
  "-  while (queue.pending) {",
  "+  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {",
  "     try {",
  "       await queue.processNext();",
  "       return;",
  "     } catch (error) {",
  "-      await sleep(1000);",
  "+      if (attempt === MAX_ATTEMPTS - 1) throw error;",
  "+      await sleep(Math.min(1000 * 2 ** attempt, 16000));",
  "     }",
  "   }",
  " }",
].join("\n");
const sourceControl: SourceControlState = {
  provider: "git",
  available: true,
  workspacePath: workspace,
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  additions: 36,
  deletions: 6,
  statsPartial: false,
  detailsLoaded: true,
  files: paths.map((path, i) => ({
    path,
    state: "modified",
    staged: false,
    ...counts[i]!,
  })),
  history: [
    {
      hash: "abc1234",
      shortHash: "abc1234",
      subject: "Improve queue reliability",
      author: "Fixture",
      relativeDate: "2 hours ago",
      refs: "main",
    },
  ],
};
/** ?repo=unpushed|pushed: the same branch after a commit, then after a push. */
function fixtureRepo(state: string | null): SourceControlState {
  if (state !== "unpushed" && state !== "pushed") return sourceControl;
  return {
    ...sourceControl,
    branch: "fix/sync-retries",
    upstream: "origin/fix/sync-retries",
    ahead: state === "unpushed" ? 1 : 0,
    files: [],
    additions: 0,
    deletions: 0,
    comparedToMain: { additions: 36, deletions: 6, partial: false },
    history: [
      {
        ...sourceControl.history![0]!,
        subject: "Bound the sync queue retries",
        relativeDate: "just now",
      },
    ],
  };
}
const files: WorkspaceFile[] = [
  {
    path: `${workspace}/src`,
    workspacePath: workspace,
    relativePath: "src",
    kind: "directory",
    depth: 0,
  },
  {
    path: `${workspace}/src/queue`,
    workspacePath: workspace,
    relativePath: "src/queue",
    kind: "directory",
    depth: 1,
  },
  {
    path: `${workspace}/${paths[2]}`,
    workspacePath: workspace,
    relativePath: paths[2],
    kind: "file",
    depth: 2,
  },
  ...paths.slice(0, 2).map((path) => ({
    path: `${workspace}/${path}`,
    workspacePath: workspace,
    relativePath: path,
    kind: "file" as const,
    depth: 1,
  })),
  {
    path: `${workspace}/package.json`,
    workspacePath: workspace,
    relativePath: "package.json",
    kind: "file",
    depth: 0,
  },
  {
    path: `${workspace}/README.md`,
    workspacePath: workspace,
    relativePath: "README.md",
    kind: "file",
    depth: 0,
  },
];
const review: DiffReview = {
  files: paths.map((path, i) => ({
    path,
    ...counts[i]!,
    source: "agent-generated",
    state: "pending",
    comments: 0,
    lines: [
      {
        kind: "context",
        content: "export async function drain(queue: Queue) {",
        number: 1,
      },
      { kind: "removed", content: "  while (queue.pending) {", number: 2 },
      {
        kind: "added",
        content: "  for (let attempt = 0; attempt < 5; attempt++) {",
        number: 2,
      },
      { kind: "context", content: "    await queue.processNext();", number: 3 },
      { kind: "context", content: "  }", number: 4 },
      { kind: "context", content: "}", number: 5 },
    ],
  })),
  selectedPath: paths[0]!,
  approvalState: "pending",
  commitMessage: "",
  collapsedDirectories: [],
  gitActions: [],
};
const canvasHtml = `<style>body{font:15px system-ui;color:#252525;background:#fafafa;margin:0;padding:36px}main{max-width:460px;margin:auto}small{color:#777}h1{font-size:28px;font-weight:600;letter-spacing:-.6px;margin:18px 0}p{line-height:1.6;color:#555}label{display:flex;gap:10px;padding:16px 0;border-bottom:1px solid #e5e5e5}input{accent-color:#0874df}button{margin-top:24px;background:#0874df;color:white;border:0;border-radius:7px;padding:10px 16px;font:inherit}</style><main><small>Aurora / Sync queue</small><h1>Ready for the next attempt.</h1><p>A bounded retry queue keeps background work predictable.</p><label><input type="checkbox" checked> Stop after five attempts</label><label><input type="checkbox" checked> Back off between retries</label><label><input type="checkbox"> Review the change</label><button onclick="document.querySelectorAll('input').forEach(input=>input.checked=true)">Mark all reviewed</button></main>`;
function event(
  sessionId: string,
  id: string,
  kind: SessionEvent["kind"],
  message: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    sessionId,
    turnId: `${sessionId}-turn`,
    id: `${sessionId}-${id}`,
    kind,
    message,
    payload,
    createdAt: stamp,
  };
}
function initialEvents(sessionId: string): SessionEvent[] {
  return [
    event(
      sessionId,
      "request",
      "user-message",
      "The sync queue retries forever when the server returns 503. Add bounded retries with backoff, and cover it with a test.",
    ),
    event(sessionId, "read", "system-event", "Read the sync queue", {
      kind: "provider-activity",
      activityId: "read",
      activityKind: "read",
      path: paths[0],
      label: "Read the sync queue",
      status: "done",
      timelineSequence: 1,
    }),
    event(
      sessionId,
      "edits",
      "system-event",
      "Updated retry limits and tests",
      {
        schema: "gyro.mutation.v1",
        kind: "mutation-approval",
        proposalId: "sample-edit",
        status: "applied",
        fileChanges: paths.map((path, i) => ({
          path,
          ...counts[i]!,
          patch: unified,
        })),
        timelineSequence: 2,
      },
    ),
    event(sessionId, "checks", "system-event", "Ran retry tests", {
      kind: "provider-activity",
      activityId: "checks",
      activityKind: "command",
      command: "pnpm test src/sync.test.ts",
      label: "Ran retry tests",
      status: "done",
      timelineSequence: 3,
    }),
    event(sessionId, "done", "system-event", "Completed", {
      kind: "provider-status",
      status: "done",
      durationMs: 61000,
      timelineSequence: 4,
      artifacts:
        sampleState === "empty"
          ? []
          : [
              {
                id: "retry-notes",
                kind: "canvas",
                title: "Retry implementation notes",
                format: "text",
                content:
                  "Retry limits\n\nStop after five attempts. Back off between retries. Keep the original error when the limit is reached.",
              },
              {
                id: "retry-preview",
                kind: "canvas",
                title: "Retry queue preview",
                format: "html",
                content: canvasHtml,
              },
            ],
    }),
    event(
      sessionId,
      "answer",
      "assistant-message",
      [
        "## Ready to review",
        "",
        "The queue now stops after **5 attempts** and backs off between retries.",
        "",
        "- Added bounded retries in `src/sync.ts`.",
        "- Covered the retry limit and backoff behavior with tests.",
        "",
        "### Retry limit",
        "",
        "```ts",
        "const MAX_ATTEMPTS = 5;",
        "await sleep(Math.min(1000 * 2 ** attempt, 16000));",
        "```",
        "",
        "The existing failure is preserved when the limit is reached.",
      ].join("\n"),
      { kind: "provider-response", status: "done", timelineSequence: 5 },
    ),
  ];
}
function initialPlan(sessionId: string): SessionPlan {
  return {
    sessionId,
    title: "Bound the sync queue retries",
    content:
      "# Retry plan\n\nKeep background work predictable.\n\n## Verification\n\nCover retry limits and backoff with focused tests.",
    items: [
      "Inspect the queue",
      "Add retry limits",
      "Test backoff behavior",
      "Review the changes",
    ].map((text, index) => ({
      id: String(index),
      title: text,
      // ?plan=working leaves the run on step 3, the default has it settled.
      status:
        query.get("plan") === "working"
          ? index < 2
            ? "complete"
            : index === 2
              ? "in-progress"
              : "todo"
          : index < 3
            ? "complete"
            : "todo",
      createdAt: stamp,
      updatedAt: stamp,
    })),
  };
}
function initialTerminal(id = "terminal-1"): TerminalPane {
  return {
    id,
    title: "zsh",
    profileId: "shell",
    command: "zsh",
    output:
      "$ pnpm test src/sync.test.ts\n\n ✓ stops after five attempts\n ✓ backs off between retries\n ✓ preserves the final error\n\n 3 tests passed\n\n~/aurora  main $ ",
    status: "done",
    lastEvent: "Tests passed",
    workspaceMode: "local",
    branch: "main",
    workingDirectory: workspace,
    createdAt: stamp,
  };
}
const cloudFixture = query.has("cloud");
const fixtureCloudSnapshot: BillingSnapshot = {
  cloudV2: true,
  staging: true,
  status: "active",
  plan: "plus",
  limits: {
    devices: 2,
    storageBytes: 2_000_000_000,
    historyDays: 30,
    activeLinks: 10,
    concurrentJobs: 1,
    uploadBytesPerMonth: 4_000_000_000,
    downloadBytesPerMonth: 40_000_000_000,
  },
  cloudUsage: {
    storage: {
      usedBytes: 24_000_000,
      reservedBytes: 0,
      limitBytes: 2_000_000_000,
    },
    managedAi: {
      unit: "percent",
      used: 0,
      held: 0,
      remaining: 0,
      resetAt: null,
    },
  },
};
const fixtureCloudActions = {
  preferences: () => ({}),
  applySettings: () => {},
  request: async (
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (input.operation === "preview-chat")
      return {
        kind: "chat",
        ticket: "fixture-preview-ticket",
        content: {
          format: "gyro-portable-chat-v1",
          title: input.localId === "main" ? title : "Check retry edge cases",
          messages: [
            {
              role: "user",
              text: "Bound the sync queue retries.",
              createdAt: stamp,
            },
            {
              role: "assistant",
              text: "The queue now stops after 5 attempts and backs off between retries.",
              createdAt: stamp,
            },
          ],
        },
      };
    if (input.operation === "upload-preview") {
      if (query.get("cloud") === "slow")
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (input.reviewed !== true || input.ticket !== "fixture-preview-ticket")
        throw new Error("Review the preview first.");
      return query.get("cloud") === "queued"
        ? { queued: true }
        : {
            uploaded: {
              objectId: "fixture-backup",
              unchanged: query.get("cloud") === "unchanged",
            },
          };
    }
    if (input.operation === "local-chats")
      return { items: [{ localId: "main", title }] };
    return { items: [] };
  },
};

function Pane({
  pane,
  tiled,
  onClose,
}: {
  pane: ChatPaneRef;
  tiled: boolean;
  onClose: () => void;
}) {
  const id = pane.paneId;
  const startTool = id === "main" ? requestedTool : "closed";
  const [events, setEvents] = useState(() =>
    initialEvents(id).filter(
      (item) =>
        sampleState !== "empty" ||
        (item.payload as Record<string, unknown>).kind !== "mutation-approval",
    ),
  );
  const [draft, setDraft] = useState("");
  const [environment, setEnvironment] = useState(startTool === "environment");
  const [planOpen, setPlanOpen] = useState(startTool === "plan");
  const [plan, setPlan] = useState(() => initialPlan(id));
  const [companion, dispatch] = useReducer(
    chatCompanionReducer,
    undefined,
    () => {
      let state = createInitialChatCompanionState();
      state = chatCompanionReducer(state, { type: "focus-pane", paneId: id });
      if (isChatCompanionTabId(startTool))
        state = chatCompanionReducer(state, {
          type: "open-tab",
          tab: startTool,
          paneId: id,
        });
      else if (startTool === "tools")
        state = chatCompanionReducer(state, {
          type: "show-launcher",
          paneId: id,
        });
      return state;
    },
  );
  const companionPane = chatCompanionPane(companion, id);
  const panel = planOpen ? "plan" : activeChatCompanionPanel(companion, id);
  const [diff, setDiff] = useState<DiffReview>(() =>
    sampleState === "empty" ? { ...review, files: [] } : review,
  );
  const [terminals, setTerminals] = useState(() =>
    sampleState === "empty" ? [] : [initialTerminal()],
  );
  const [terminalId, setTerminalId] = useState("terminal-1");
  const [profileId, setProfileId] = useState("shell");
  const [browser, setBrowser] = useState<BrowserPreview>({
    url: sampleState === "empty" ? "" : previewUrl,
    title: "Aurora",
    history: [previewUrl],
    historyIndex: 0,
    device: "desktop",
    consoleErrors: sampleState === "issues" ? 2 : 0,
    diagnostics: [],
    diagnosticsSupported: sampleState === "issues",
    diagnosticsCaptured: sampleState === "issues",
    captureStatus: "idle",
    status:
      sampleState === "empty"
        ? "idle"
        : sampleState === "failed"
          ? "verification-failed"
          : sampleState === "loading"
            ? "loading"
            : sampleState === "issues"
              ? "console-error"
              : "ready",
    verificationMessage: "Local sample preview",
  });
  const [sideMessages, setSideMessages] = useState<SideChatMessage[]>(() =>
    sampleState === "empty"
      ? []
      : [
          {
            id: "side-user",
            role: "user",
            text: "Why use exponential backoff here?",
          },
          {
            id: "side-answer",
            role: "assistant",
            text: "## Give the service time to recover\n\nEach retry waits a little longer, reducing pressure while the server is unavailable.\n\nThe **5-attempt limit** keeps the queue from waiting forever.",
          },
        ],
  );
  const [sideStream, setSideStream] = useState(
    sampleState === "streaming"
      ? "Exponential backoff gives the service time to recover"
      : "",
  );
  const [sideError, setSideError] = useState(
    sampleState === "failed"
      ? "The sample response could not be completed. Try sending again."
      : "",
  );
  const sideTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(sideTimer.current), []);
  const [agentTabs, setAgentTabs] = useState<SubagentTabState>({
    openAgentIds: ["retry-review"],
    selectedAgentId: "retry-review",
  });
  const [agent, setAgent] = useState<SubagentSnapshot>({
    agentId: "retry-review",
    parentSessionId: id,
    parentTurnId: `${id}-turn`,
    name: "Retry review",
    task: "Check retry limits and test coverage. Report any edge cases.",
    providerId: "anthropic",
    readOnly: true,
    status: sampleState === "streaming" ? "running" : "completed",
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: null,
    elapsedMs: 43000,
    tokens: {
      inputTokens: 1200,
      outputTokens: 320,
      totalTokens: 1520,
      measured: true,
    },
    runId: "retry-review-turn",
    summary:
      "Retry bounds and backoff are covered. The final error is preserved.",
  });
  const [agentError, setAgentError] = useState(
    sampleState === "failed" ? "Could not refresh agent status." : "",
  );
  const open = (tool?: ChatSidePanelId) => {
    setPlanOpen(tool === "plan");
    setEnvironment(tool === "environment");
    if (tool && isChatCompanionTabId(tool))
      dispatch({ type: "open-tab", tab: tool, paneId: id });
    else
      dispatch({
        type: tool === "tools" ? "show-launcher" : "close-dock",
        paneId: id,
      });
  };
  const closeTab = (tab: ChatCompanionTabId) => {
    dispatch({ type: "close-tab", tab, paneId: id });
    if (tab === "side-chat") {
      window.clearTimeout(sideTimer.current);
      setSideMessages([]);
      setSideStream("");
      setSideError("");
    }
  };
  const addTerminal = () => {
    const next = initialTerminal(`terminal-${Date.now()}`);
    setTerminals((current) => [...current, next]);
    setTerminalId(next.id);
  };
  const navigate = (url: string) => {
    try {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin)
        throw new Error("Use the local sample page in this fixture.");
      setBrowser((current) => ({
        ...current,
        url: target.href,
        history: [
          ...current.history.slice(0, current.historyIndex + 1),
          target.href,
        ],
        historyIndex: current.historyIndex + 1,
        status: "ready",
      }));
    } catch {
      setBrowser((current) => ({
        ...current,
        status: "verification-failed",
        verificationMessage: "This fixture only opens its local sample page.",
      }));
    }
  };
  const send = (message: string) => {
    setDraft("");
    setEvents((current) => [
      ...current,
      event(id, `sent-${current.length}`, "user-message", message),
      event(
        id,
        `response-${current.length}`,
        "assistant-message",
        "The local sample received your request. No provider was contacted.",
      ),
    ]);
  };
  return (
    <ChatSurface
      config={config}
      events={events}
      paneKey={id}
      isComposerSending={
        query.get("activity")?.split(",").includes(id) &&
        query.get("activityStatus") !== "stopped"
      }
      capabilityActivities={
        query.get("activity")?.split(",").includes(id)
          ? [
              {
                schema: "gyro.capability.v1",
                kind: "capability-call",
                callId: `fixture-tool-${id}`,
                capabilityId: "browser-read-page",
                status:
                  query.get("activityStatus") === "completed"
                    ? "completed"
                    : "running",
                providerId: "anthropic",
                policyRevision: 1,
                summary: "Reading the local preview",
                sessionId: id,
                createdAt: stamp,
              },
            ]
          : []
      }
      sessionTitle={id === "main" ? title : "Check retry edge cases"}
      workspacePath={workspace}
      branchName="main"
      shellReady
      isTiled={tiled}
      sessionModel={{
        providerId: "anthropic",
        providerLabel: "Claude",
        modelLabel: "Claude Opus 5",
        reasoningEffort: "high",
      }}
      draft={draft}
      onDraftChange={setDraft}
      onSend={send}
      onCloseChat={onClose}
      activeChatPanel={panel}
      companionTabs={companionPane.openTabs}
      onOpenCompanionTab={open}
      backupReview={
        cloudFixture && pane.kind === "session"
          ? {
              localId: id,
              available: true,
              accountKey: "fixture",
              request: fixtureCloudActions.request,
              uploading: query.get("cloud") === "auto-upload",
            }
          : undefined
      }
      onSelectChatPanel={open}
      onCloseCompanionTab={closeTab}
      onShowCompanionLauncher={() => open("tools")}
      onCloseCompanionDock={() => open(undefined)}
      onReopenCompanionDock={() =>
        dispatch({ type: "reopen-dock", paneId: id })
      }
      companionWidth={companion.dockWidth}
      browserCompanionWidth={companion.browserDockWidth}
      onCompanionWidthChange={(width, mode) =>
        dispatch(
          mode === "panel"
            ? { type: "resize-panel", width }
            : { type: "resize-dock", width, mode },
        )
      }
      isToolPanelAvailable={false}
      isEnvironmentRailOpen={environment}
      onToggleEnvironmentRail={() => {
        if (panel) open("environment");
        else setEnvironment((current) => !current);
      }}
      files={sampleState === "empty" ? [] : files}
      onOpenCompanionFile={(path) => {
        setDiff((current) => ({
          ...current,
          selectedPath: path.replace(`${workspace}/`, ""),
        }));
        open("review");
      }}
      sourceControl={
        sampleState === "empty"
          ? { ...sourceControl, files: [], additions: 0, deletions: 0 }
          : fixtureRepo(query.get("repo"))
      }
      diffReview={query.get("review") === "proposed" ? diff : undefined}
      onLoadChangeDiff={async () => unified}
      onLoadComparisonDiff={async () => {
        if (sampleState === "loading") return new Promise(() => {});
        if (sampleState === "failed")
          throw new Error("The local sample diff is unavailable.");
        return {
          original: "const MAX_ATTEMPTS = Infinity;",
          modified: "const MAX_ATTEMPTS = 5;",
          unified,
        };
      }}
      railDiffTools={{
        // The real app runs git here; the fixture only needs the rows live.
        onRunGitAction: () => undefined,
        onSelectFile: (path) =>
          setDiff((current) => ({ ...current, selectedPath: path })),
        onToggleDirectory: (directory) =>
          setDiff((current) => ({
            ...current,
            collapsedDirectories: current.collapsedDirectories.includes(
              directory,
            )
              ? current.collapsedDirectories.filter(
                  (value) => value !== directory,
                )
              : [...current.collapsedDirectories, directory],
          })),
        onAcceptFile: (path) =>
          setDiff((current) => ({
            ...current,
            files: current.files.map((file) =>
              file.path === path ? { ...file, state: "accepted" } : file,
            ),
          })),
        onRejectFile: (path) =>
          setDiff((current) => ({
            ...current,
            files: current.files.map((file) =>
              file.path === path ? { ...file, state: "rejected" } : file,
            ),
          })),
        onUndo: () => setDiff(review),
      }}
      terminalPanes={terminals}
      railTerminalTools={{
        profiles: terminalDefaultProfiles(),
        activeProfileId: profileId,
        selectedTerminalPaneId: terminalId,
        output: "",
        onProfileChange: setProfileId,
        onRunProfile: addTerminal,
        onAddTerminalPane: addTerminal,
        onSelectTerminalPane: setTerminalId,
        onCloseTerminalPane: (terminal) =>
          setTerminals((current) => {
            const next = current.filter((item) => item.id !== terminal);
            setTerminalId(next[0]?.id ?? "");
            return next;
          }),
        onSplitTerminalPane: addTerminal,
        renderTerminalPaneBody: (terminal) => (
          <pre
            style={{
              margin: 0,
              padding: "18px 16px",
              fontFamily: "var(--gyro-font-mono)",
              fontSize: 13,
              lineHeight: 1.65,
              whiteSpace: "pre-wrap",
              color: "var(--gyro-text)",
            }}
          >
            {terminal.output}
          </pre>
        ),
      }}
      browserPreview={browser}
      onBrowserNavigate={navigate}
      onBrowserReload={() =>
        setBrowser((current) => ({
          ...current,
          status: "ready",
          url: previewUrl,
        }))
      }
      onBrowserBack={() =>
        setBrowser((current) => ({
          ...current,
          historyIndex: Math.max(0, current.historyIndex - 1),
          url: current.history[Math.max(0, current.historyIndex - 1)]!,
        }))
      }
      onBrowserForward={() =>
        setBrowser((current) => ({
          ...current,
          historyIndex: Math.min(
            current.history.length - 1,
            current.historyIndex + 1,
          ),
          url: current.history[
            Math.min(current.history.length - 1, current.historyIndex + 1)
          ]!,
        }))
      }
      onBrowserDeviceChange={(device) =>
        setBrowser((current) => ({
          ...current,
          device: device === "auto" ? "responsive" : device,
        }))
      }
      sideChat={{
        messages: sideMessages,
        streamingMessage: sideStream,
        isSending: Boolean(sideStream),
        error: sideError,
        modelLabel: "Claude Opus 5",
        onSend: (message) => {
          setSideError("");
          setSideMessages((current) => [
            ...current,
            { id: `question-${Date.now()}`, role: "user", text: message },
          ]);
          setSideStream("Checking the retry behavior…");
          sideTimer.current = window.setTimeout(() => {
            setSideStream("");
            setSideMessages((current) => [
              ...current,
              {
                id: `reply-${Date.now()}`,
                role: "assistant",
                text: "The limit prevents an endless retry loop. Backoff gives the service time to recover between attempts.",
              },
            ]);
          }, 700);
        },
        onStop: () => {
          window.clearTimeout(sideTimer.current);
          setSideStream("");
        },
      }}
      subagents={{
        agents: sampleState === "empty" ? [] : [agent],
        ...agentTabs,
        eventsByAgentId: {
          "retry-review": [
            event("retry-review", "read", "system-event", "Read retry tests", {
              kind: "provider-activity",
              activityKind: "read",
              activityId: "agent-read",
              path: paths[1],
              status: "done",
            }),
            event(
              "retry-review",
              "answer",
              "assistant-message",
              "## Retry behavior is covered\n\nThe tests verify the **5-attempt limit**, backoff, and the original error on the final attempt.",
            ),
          ],
        },
        onSelect: (agentId) => {
          setAgentTabs((current) => openSubagentTab(current, agentId));
          open("agents");
        },
        onClose: (agentId) => {
          const next = closeSubagentTab(agentTabs, agentId);
          setAgentTabs(next);
          if (!next.openAgentIds.length) closeTab("agents");
        },
        onStop: () =>
          setAgent((current) => ({ ...current, status: "cancelled" })),
        error: agentError,
        onRefresh: () => setAgentError(""),
      }}
      sessionPlan={plan}
      onTogglePlanPanel={() => open(planOpen ? undefined : "plan")}
      onPlanItemStatusChange={(itemId, status) =>
        setPlan((current) => ({
          ...current,
          items: current.items.map((item) =>
            item.id === itemId ? { ...item, status } : item,
          ),
        }))
      }
      onPlanAction={(action, itemId, value) =>
        setPlan((current) => {
          let items = [...current.items];
          const index = items.findIndex((item) => item.id === itemId);
          if (action === "add")
            items.push({
              id: `step-${Date.now()}`,
              title: value ?? "New step",
              status: "todo",
              createdAt: stamp,
              updatedAt: stamp,
            });
          if (action === "edit" && index >= 0)
            items[index] = {
              ...items[index]!,
              title: value ?? items[index]!.title,
            };
          if (action === "remove")
            items = items.filter((item) => item.id !== itemId);
          const next =
            action === "move-up"
              ? index - 1
              : action === "move-down"
                ? index + 1
                : -1;
          if (index >= 0 && next >= 0 && next < items.length)
            [items[index], items[next]] = [items[next]!, items[index]!];
          return { ...current, items };
        })
      }
    />
  );
}

const mainPane = {
  paneId: "main",
  kind: "session",
  sessionId: "main",
  workspacePath: workspace,
} satisfies ChatPaneRef;
const sessions: Session[] = [
  title,
  "Fix flaky editor file tree",
  "Audit provider arguments",
].map((text, index) => ({
  id: index ? `session-${index}` : "main",
  title: text,
  workspacePath: workspace,
  origin: "desktop",
  createdAt: stamp,
  updatedAt: stamp,
  eventsPath: `/fixture/${index}.jsonl`,
}));
function Fixture() {
  const [destination, setDestination] = useState<AppDestination>("workspace");
  const [grid, dispatch] = useReducer(
    chatGridReducer,
    undefined,
    (): ChatGridState => {
      const initial: ChatGridState = {
        activeProjectKey: workspace,
        layouts: { [workspace]: createChatProjectLayout(workspace, mainPane) },
      };
      if (query.get("split") === "4") {
        return {
          ...initial,
          layouts: {
            [workspace]: {
              ...initial.layouts[workspace]!,
              arrangement: "grid",
              slots: ["main", "secondary", "third", "fourth"].map((id) => ({
                ...mainPane,
                paneId: id,
                sessionId: id,
              })),
              focusedPaneId: "main",
            },
          },
        };
      }
      if (query.get("split") !== "1") return initial;
      const splitState = chatGridReducer(initial, {
        type: "select-pane",
        projectKey: workspace,
        mode: "drop",
        slotIndex: 0,
        insertPosition: "after",
        splitDirection:
          query.get("arrangement") === "rows" ? "vertical" : "horizontal",
        arrangement: query.get("arrangement") === "rows" ? "rows" : "columns",
        pane: { ...mainPane, paneId: "secondary", sessionId: "secondary" },
      });
      return chatGridReducer(splitState, {
        type: "focus-pane",
        projectKey: workspace,
        paneId: "main",
      });
    },
  );
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = "compact";
    applyAppearancePreferences(
      document.documentElement,
      {
        interfaceSize: "default",
        mainColor: "#0874df",
        secondaryColor: "#8b6fcb",
        motionSpeed: "default",
      },
      theme,
    );
    document.documentElement.dataset.companionPolishFixture = "true";
  }, []);
  const layout = grid.layouts[workspace]!;
  const newChat = () =>
    dispatch({
      type: "select-pane",
      projectKey: workspace,
      mode: "replace",
      pane: {
        kind: "draft",
        paneId: `draft-${Date.now()}`,
        draftKey: "new",
        workspacePath: workspace,
      },
    });
  return (
    <>
      <style>{`.companion-polish-stage{height:100dvh;min-height:0;overflow:hidden}.companion-polish-stage>.gyro-app-shell{height:100%;min-height:0;grid-template-rows:minmax(0,1fr)}.companion-polish-stage .gyro-main{height:100%;max-height:100%;min-height:0}.companion-polish-stage .gyro-sidebar{height:100%;max-height:100%;min-height:0}`}</style>
      <main className="companion-polish-stage">
        <AppChrome
          activeDestination={destination}
          activeSessionId="main"
          activeWorkspaceLayout="thread"
          commandProfiles={[]}
          savedProjects={[]}
          sessions={sessions}
          sendingSessionIds={
            query.get("sidebarState") === "working" ? ["main"] : []
          }
          approvalCountsBySessionId={
            query.get("sidebarState") === "approval" ? { main: 1 } : {}
          }
          questionCountsBySessionId={
            query.get("sidebarState") === "question" ? { main: 1 } : {}
          }
          workspacePath={workspace}
          onCreateSession={newChat}
          onCreateCliSession={() => {}}
          onOpenCommandPalette={() => {}}
          onOpenSettings={() => {}}
          onOpenToolPanel={() => {}}
          onOpenWorkspace={() => {}}
          onSelectDestination={setDestination}
          onSelectSessions={() => {}}
          onSelectWorkspaceLayout={() => {}}
          onSelectSession={(sessionId) =>
            dispatch({
              type: "select-pane",
              projectKey: workspace,
              mode: "replace",
              pane: { ...mainPane, sessionId },
            })
          }
        >
          {destination === "cloud" ? (
            <div className="gyro-settings-surface gyro-cloud-workspace">
              <div className="gyro-settings-content">
                <CloudSettings
                  workspace
                  snapshot={fixtureCloudSnapshot}
                  actions={{ cloud: fixtureCloudActions }}
                  onManageCloud={() => setDestination("workspace")}
                />
              </div>
            </div>
          ) : (
            <ChatGridSurface
              layout={layout}
              maximizedPaneId={grid.maximizedPaneId}
              onDropSession={(sessionId, _source, slotIndex, placement) =>
                dispatch({
                  type: "select-pane",
                  projectKey: workspace,
                  mode: "drop",
                  slotIndex,
                  pane: { ...mainPane, paneId: sessionId, sessionId },
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
              renderPane={(pane, options) => (
                <Pane
                  key={pane.paneId}
                  pane={pane}
                  tiled={options.isTiled}
                  onClose={() =>
                    dispatch({
                      type: "close-pane",
                      projectKey: workspace,
                      paneId: pane.paneId,
                    })
                  }
                />
              )}
            >
              <Pane pane={mainPane} tiled={false} onClose={() => {}} />
            </ChatGridSurface>
          )}
        </AppChrome>
      </main>
    </>
  );
}
function BrowserSample() {
  const [reviewed, setReviewed] = useState(false);
  return (
    <main
      style={{
        boxSizing: "border-box",
        minHeight: "100%",
        padding: "40px 32px",
        background: "#fafafa",
        color: "#242424",
        fontFamily: "system-ui",
      }}
    >
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        <small style={{ color: "#777" }}>Aurora / Sync queue</small>
        <h1
          style={{
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: "-0.7px",
            margin: "20px 0 14px",
          }}
        >
          A little room to recover.
        </h1>
        <p style={{ lineHeight: 1.65, color: "#606060" }}>
          Background work retries safely, then gives you a clear result.
        </p>
        <div
          style={{
            marginTop: 32,
            padding: "18px 0",
            borderTop: "1px solid #ddd",
            borderBottom: "1px solid #ddd",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>Maximum attempts</span>
          <strong>5</strong>
        </div>
        <div
          style={{
            padding: "18px 0",
            borderBottom: "1px solid #ddd",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>Backoff</span>
          <strong>Exponential</strong>
        </div>
        <button
          onClick={() => setReviewed(!reviewed)}
          style={{
            marginTop: 28,
            padding: "10px 16px",
            background: "#0874df",
            color: "white",
            border: 0,
            borderRadius: 7,
            font: "inherit",
          }}
        >
          {reviewed ? "Reviewed" : "Review queue"}
        </button>
      </div>
    </main>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    query.get("page") === "preview" ? <BrowserSample /> : <Fixture />,
  );
