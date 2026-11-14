import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ChatSurface,
  confirmAction,
  ChatFileActionsContext,
  type ChatEnvironmentRemote,
  type GyroConfig,
  type ProviderId,
  type ReasoningEffort,
} from "@gyro-dev/ui";
import {
  Eye,
  FolderOpen,
  GitBranch,
  Terminal,
} from "../../../../packages/ui/node_modules/lucide-react";
import { useRemoteAccess, useRemoteTheme } from "./context";
import { useRemoteWorkspace } from "./use-workspace";
import { RemoteFiles, RemoteGit, RemoteTerminals } from "./workspace-panels";
import { CommandApprovalCard, MutationReviewPanel } from "./workspace-review";
import type { Control, HostInfo, ModelChoice, Peer } from "./types";

function configFromHost(info?: HostInfo, choice?: ModelChoice): GyroConfig {
  return {
    telemetryEnabled: false,
    requireCommandApproval: true,
    requireFileEditApproval: true,
    selectedProviderId: (choice?.providerId ?? info?.selectedProviderId) as
      ProviderId | undefined,
    commandProfiles: [],
    modelProviders: (info?.providers ?? []).map((provider) => ({
      id: provider.id as ProviderId,
      displayName: provider.displayName,
      apiKeyRef: "remote-host",
      enabled: true,
      authMode: "sdk",
      authStatus:
        provider.runtimeStatus === "ready" ? "connected" : "not-connected",
      kind: provider.kind,
      models: provider.models.map((id) => ({ id, displayName: id })),
      defaultModelId: provider.defaultModelId,
      selectedModelId:
        choice?.providerId === provider.id
          ? choice.modelId
          : (provider.defaultModelId ?? provider.models[0]),
    })),
  };
}

const PANELS = [
  { id: "files", label: "Files", Icon: FolderOpen },
  { id: "git", label: "Source Control", Icon: GitBranch },
  { id: "terminal", label: "Terminal", Icon: Terminal },
] as const;

const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
function ago(timestamp: string) {
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}

import type { RemoteSelection } from "./catalog";

export default function RemoteWorkspace({
  host,
  selection,
}: {
  host: Peer;
  selection: RemoteSelection;
}) {
  useRemoteTheme();
  const workspace = useRemoteWorkspace(host.id, selection);
  const { view, setView, data, online, owns, busy, error, run, selectSession } =
    workspace;
  const access = useRemoteAccess();
  const [selected, setSelected] = useState<ModelChoice>();
  useEffect(
    () => setSelected(undefined),
    [selection.projectId, selection.sessionId],
  );
  const [worktree, setWorktree] = useState(false);
  const [homeDraft, setHomeDraft] = useState("");
  // The chat's Environment card holds the connection and remote tools. A
  // tool panel takes its place on the right; the top bar brings it back.
  const [environmentOpen, setEnvironmentOpen] = useState(true);
  // A prompt typed on the home composer waits here until its new chat is
  // open and owned, then goes through the normal submit path.
  const [queued, setQueued] = useState<{ sessionId: string; text: string }>();
  const session =
    data.snapshot?.session ??
    data.sessions.find((s) => s.id === view.sessionId);
  const initialProvider =
    data.info?.providers.find((p) => p.id === data.info?.selectedProviderId) ??
    data.info?.providers[0];
  const model = selected ?? {
    providerId: session?.providerId ?? initialProvider?.id ?? "",
    modelId:
      session?.modelId ??
      initialProvider?.defaultModelId ??
      initialProvider?.models[0] ??
      "",
    reasoningEffort: session?.reasoningEffort,
  };
  const config = useMemo(
    () => configFromHost(data.info, model),
    [data.info, model.providerId, model.modelId],
  );
  const selectedProject = data.projects.find((p) => p.id === view.projectId);
  const panel = view.panel;
  const controls = data.snapshot?.control;
  const pendingSubmission = session
    ? view.pendingSubmissions[session.id]
    : undefined;
  const approvals = session ? (data.snapshot?.approvals ?? []) : [];
  const mutations = session ? (data.snapshot?.mutations ?? []) : [];
  const canDecide = owns && online && !busy;
  const peerName = (id?: string | null) =>
    access.status?.peers.find((p) => p.id === id)?.name ?? "Another device";
  const modelOptions =
    data.info?.providers.flatMap((p) =>
      p.models.map((id) => ({
        providerId: p.id,
        modelId: id,
        label: `${p.displayName} · ${id}`,
      })),
    ) ?? [];
  useEffect(() => {
    if (queued && session?.id === queued.sessionId && owns && online && !busy) {
      setQueued(undefined);
      void workspace.submit(queued.text, model);
    }
  }, [queued, session?.id, owns, online, busy]);
  const selectProject = (path: string) => {
    const project = data.projects.find((p) => p.path === path);
    if (project) {
      access.selectRemote({ hostId: host.id, projectId: project.id });
      selectSession(undefined);
      setView((previous) => ({ ...previous, projectId: project.id }));
    }
  };
  const select = (id: string) => {
    setSelected(undefined);
    access.selectRemote({
      hostId: host.id,
      projectId: view.projectId,
      sessionId: id,
    });
    selectSession(id);
  };
  const create = async () => {
    const branch = worktree ? `remote/${Date.now()}` : undefined;
    const id = await workspace.createSession(model, branch);
    if (id) {
      access.selectRemote({
        hostId: host.id,
        projectId: view.projectId,
        sessionId: id,
      });
      void access.refreshCatalog();
    }
    return id;
  };
  const startChat = async (event: FormEvent) => {
    event.preventDefault();
    const text = homeDraft.trim();
    if (!text) return;
    const id = await create();
    if (id) {
      setQueued({ sessionId: id, text });
      setHomeDraft("");
    }
  };
  const openPanel = (value: (typeof PANELS)[number]["id"]) =>
    setView((previous) => ({ ...previous, panel: value }));
  const toggleEnvironment = () => {
    if (panel !== "chat") {
      setView((previous) => ({ ...previous, panel: "chat" }));
      setEnvironmentOpen(true);
    } else setEnvironmentOpen((open) => !open);
  };
  const decide = (
    approvalId: string,
    kind: "provider" | "capability" | "mutation",
    decision: "approve" | "reject",
    turnId?: string,
  ) => {
    if (session && canDecide)
      void run({
        op: "approval",
        sessionId: session.id,
        approvalId,
        turnId,
        kind,
        decision,
      });
  };
  const blocked = !online
    ? `Read only until ${host.name} is back.`
    : !owns
      ? "Watching. Take control to send."
      : pendingSubmission
        ? "Checking the previous submission. Refresh before sending again."
        : busy
          ? "Waiting for the host…"
          : data.snapshot?.running
            ? "A response is running on the host."
            : undefined;
  const readOnly = Boolean(session) && !workspace.loading && !online;
  const reconnect = (
    <div className="gyro-remote-readonly" role="status">
      <span>Read only until {host.name} is back.</span>
      <button
        type="button"
        className="gyro-primary-button"
        disabled={busy}
        onClick={() => void workspace.load()}
      >
        Reconnect
      </button>
    </div>
  );
  const resolveSubmission = () => {
    if (!session) return;
    void confirmAction(
      "This prompt may already have run on the host. Clear its pending state and keep the draft for manual review?",
    ).then((yes) => {
      if (yes)
        setView((previous) => {
          const pendingSubmissions = { ...previous.pendingSubmissions };
          delete pendingSubmissions[session.id];
          return { ...previous, pendingSubmissions };
        });
    });
  };
  // Above the composer: only what blocks the next prompt.
  const notices = [
    error && !readOnly ? (
      <p key="error" className="gyro-remote-error" role="alert">
        {error}
      </p>
    ) : null,
    pendingSubmission && session ? (
      <div
        key="pending"
        className="gyro-remote-banner is-warning"
        role="status"
      >
        <span>
          The last prompt wasn't acknowledged. Gyro will check it without
          sending it again.
        </span>
        <span className="gyro-remote-spacer" />
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!online || busy || data.snapshot?.running}
          onClick={resolveSubmission}
        >
          Resolve submission
        </button>
      </div>
    ) : null,
    ...approvals.map((approval, index) => (
      <CommandApprovalCard
        key={approval.id}
        approval={approval}
        host={host.name}
        branch={session?.worktreeName ?? session?.branch}
        canDecide={canDecide}
        primary={owns && index === 0}
        onDecide={(decision) =>
          decide(approval.id, approval.kind, decision, approval.turnId)
        }
      />
    )),
  ].filter(Boolean);
  const chatNotice = readOnly ? (
    environmentOpen && panel === "chat" ? undefined : (
      reconnect
    )
  ) : notices.length ? (
    <div className="gyro-remote-stack">{notices}</div>
  ) : undefined;
  const connection = workspace.loading
    ? { status: "connecting" as const, label: "Connecting…" }
    : online
      ? { status: "online" as const, label: "Connected · Experimental" }
      : { status: "offline" as const, label: "Unavailable" };
  const watching = Boolean(session) && online && !owns;
  const requestedBy = owns ? controls?.requestedBy : undefined;
  const environmentRemote: ChatEnvironmentRemote | undefined = session
    ? {
        host: host.name,
        status: connection.status,
        statusLabel: connection.label,
        location: [
          selectedProject?.name,
          session.worktreeName ?? session.branch,
        ]
          .filter(Boolean)
          .join(" · "),
        notices: [
          ...(watching
            ? [
                {
                  id: "watching",
                  icon: <Eye size={13} aria-hidden />,
                  text: controls
                    ? `You're watching. ${peerName(controls.owner)} has control, so prompts and approvals are off.`
                    : "You're watching. Prompts and approvals are off until you take control.",
                },
              ]
            : []),
          ...(requestedBy
            ? [
                {
                  id: "request",
                  text: `${peerName(requestedBy)} asked for control.`,
                  tone: "warning" as const,
                },
              ]
            : []),
          ...(workspace.storageWarning
            ? [
                {
                  id: "storage",
                  text: "Browser storage is full. Your drafts and edits stay available while this window is open.",
                  tone: "warning" as const,
                },
              ]
            : []),
        ],
        rows: online
          ? PANELS.map(({ id, label, Icon }) => ({
              id,
              icon: <Icon size={13} aria-hidden />,
              label,
              pressed: panel === id,
              onClick: () => openPanel(id),
            }))
          : [],
        actions: [
          ...(!online
            ? [
                {
                  id: "reconnect",
                  label: "Reconnect",
                  primary: true,
                  disabled: busy || workspace.loading,
                  onClick: () => void workspace.load(),
                },
              ]
            : []),
          ...(watching
            ? [
                {
                  id: "take",
                  label: "Take control",
                  primary: true,
                  disabled: busy,
                  onClick: () => void workspace.claim(),
                },
              ]
            : []),
          ...(watching && controls
            ? [
                {
                  id: "request",
                  label: controls.requestedBy
                    ? "Control requested"
                    : "Request control",
                  disabled: busy || Boolean(controls.requestedBy),
                  onClick: () =>
                    void run<Control>({
                      op: "requestControl",
                      sessionId: session.id,
                    }),
                },
              ]
            : []),
          ...(requestedBy
            ? [
                {
                  id: "transfer",
                  label: "Transfer control",
                  disabled: busy,
                  onClick: () =>
                    void run({
                      op: "transferControl",
                      sessionId: session.id,
                      peerId: requestedBy,
                    }),
                },
              ]
            : []),
          {
            id: "local",
            label: "This Mac",
            onClick: () => access.selectHost(),
          },
        ],
        onRefresh: online ? () => void workspace.load() : undefined,
        isRefreshing: busy,
      }
    : undefined;
  const side =
    session && !readOnly && mutations.length ? (
      <MutationReviewPanel
        mutations={mutations}
        canDecide={canDecide}
        primary={owns && !approvals.length}
        onDecide={(id, decision) => decide(id, "mutation", decision)}
      />
    ) : session && panel !== "chat" ? (
      <aside
        className="gyro-remote-side"
        aria-label={PANELS.find((p) => p.id === panel)?.label}
      >
        {panel === "files" && (
          <RemoteFiles
            workspace={workspace}
            hostId={host.id}
            session={session}
          />
        )}
        {panel === "git" && (
          <RemoteGit workspace={workspace} session={session} />
        )}
        {panel === "terminal" && (
          <RemoteTerminals workspace={workspace} session={session} />
        )}
      </aside>
    ) : undefined;
  // Without a chat there's no Environment card, so the home hero says which
  // Mac this is and how to get back to your own.
  const homeHead = (
    <div className="gyro-remote-actions">
      <h2>Code on {host.name}</h2>
      <span className="gyro-remote-spacer" />
      <span
        className={online ? "gyro-status-dot" : "gyro-attention-dot"}
        aria-hidden
      />
      <span className="gyro-remote-meta" role="status">
        {connection.label}
      </span>
      <button
        type="button"
        className="gyro-secondary-button"
        onClick={() => access.selectHost()}
      >
        This Mac
      </button>
    </div>
  );
  const recent = [...data.sessions]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 5);
  return (
    <div className="gyro-remote-workspace">
      {!session && workspace.loading && (
        <div className="gyro-remote-empty" role="status">
          <p>Connecting to {host.name}…</p>
        </div>
      )}
      {!session && !workspace.loading && !online && (
        <div className="gyro-remote-home">
          {homeHead}
          {reconnect}
        </div>
      )}
      {!session && !workspace.loading && online && !data.projects.length && (
        <div className="gyro-remote-empty">
          <h2>No shared projects</h2>
          <p>
            Projects added to the sidebar on {host.name} appear here
            automatically.
          </p>
        </div>
      )}
      {!session && !workspace.loading && online && data.projects.length > 0 && (
        <div className="gyro-remote-home">
          {homeHead}
          {error && (
            <p className="gyro-remote-error" role="alert">
              {error}
            </p>
          )}
          <form className="gyro-remote-composer" onSubmit={startChat}>
            <textarea
              aria-label="First prompt"
              placeholder={`Ask Gyro to work in ${selectedProject?.name ?? "this project"}`}
              rows={3}
              value={homeDraft}
              onChange={(event) => setHomeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                  event.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="gyro-remote-actions">
              <select
                className="gyro-settings-select"
                aria-label="Remote project"
                value={view.projectId ?? ""}
                onChange={(event) => {
                  selectSession(undefined);
                  setView((previous) => ({
                    ...previous,
                    projectId: event.target.value,
                  }));
                }}
              >
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                className="gyro-settings-select"
                aria-label="Host model"
                value={`${model.providerId}:${model.modelId}`}
                disabled={!modelOptions.length}
                onChange={(event) => {
                  const option = modelOptions.find(
                    (m) =>
                      `${m.providerId}:${m.modelId}` === event.target.value,
                  );
                  if (option)
                    setSelected({
                      providerId: option.providerId,
                      modelId: option.modelId,
                    });
                }}
              >
                {!modelOptions.length && (
                  <option value=":">No models on {host.name}</option>
                )}
                {modelOptions.map((m) => (
                  <option
                    key={`${m.providerId}:${m.modelId}`}
                    value={`${m.providerId}:${m.modelId}`}
                  >
                    {m.label}
                  </option>
                ))}
              </select>
              <label className="gyro-remote-check">
                <input
                  type="checkbox"
                  checked={worktree}
                  onChange={(event) => setWorktree(event.target.checked)}
                />
                Worktree
              </label>
              <span className="gyro-remote-spacer" />
              <button
                type="submit"
                className="gyro-primary-button"
                disabled={
                  busy || !homeDraft.trim() || !view.projectId || !model.modelId
                }
              >
                {busy ? "Starting…" : "Start chat"}
              </button>
            </div>
          </form>
          <section className="gyro-remote-recent" aria-label="Recent chats">
            <h3>Recent chats</h3>
            {recent.length ? (
              recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="gyro-remote-recent-row"
                  onClick={() => select(s.id)}
                >
                  <span>{s.title}</span>
                  <time dateTime={s.updatedAt}>{ago(s.updatedAt)}</time>
                </button>
              ))
            ) : (
              <p className="gyro-remote-meta">
                No chats in {selectedProject?.name ?? "this project"} yet.
              </p>
            )}
          </section>
        </div>
      )}
      {session && (
        <div
          className={`gyro-remote-split${side ? (mutations.length && !readOnly ? " has-review" : " has-side") : ""}`}
        >
          <div className={`gyro-remote-chat${readOnly ? " is-readonly" : ""}`}>
            <ChatFileActionsContext.Provider
              value={{
                preview: async () => undefined,
                open: (path) => void workspace.openRemoteFile(path),
              }}
            >
              <ChatSurface
                config={config}
                events={workspace.events}
                sessionTitle={session.title}
                workspacePath={session.workspacePath}
                paneKey={`remote:${host.id}:${session.id}`}
                draft={view.drafts[session.id] ?? ""}
                onDraftChange={(text) =>
                  setView((previous) => ({
                    ...previous,
                    drafts: { ...previous.drafts, [session.id]: text },
                  }))
                }
                onSend={(message) => void workspace.submit(message, model)}
                sessionModel={{
                  providerId: model.providerId as ProviderId,
                  modelId: model.modelId,
                  reasoningEffort: model.reasoningEffort as ReasoningEffort,
                }}
                composerBlockedReason={blocked}
                environmentRemote={environmentRemote}
                sourceControl={data.git?.status}
                isEnvironmentRailOpen={environmentOpen && panel === "chat"}
                onToggleEnvironmentRail={toggleEnvironment}
                chatNotice={chatNotice}
                isComposerSending={Boolean(data.snapshot?.running)}
                isToolPanelAvailable={false}
                onOpenCompanionFile={(path) =>
                  void workspace.openRemoteFile(path)
                }
                onComposerAction={(action) => {
                  const choice = modelOptions.find(
                    (option) =>
                      action ===
                      `select-provider-model:${option.providerId}:${option.modelId}`,
                  );
                  if (choice) {
                    setSelected({
                      providerId: choice.providerId,
                      modelId: choice.modelId,
                    });
                    return;
                  }
                  const effort = action.match(
                    /^select-provider-effort:.*:(low|medium|high|xhigh|max|ultra)$/,
                  )?.[1];
                  if (effort) {
                    setSelected({ ...model, reasoningEffort: effort });
                    return;
                  }
                  if (
                    action === "set-workspace-mode:worktree" ||
                    action === "set-workspace-mode:local"
                  ) {
                    setWorktree(action.endsWith("worktree"));
                    return;
                  }
                  workspace.setError(
                    "This action is unavailable remotely. Manage provider setup and permission policy on the host.",
                  );
                }}
                onStopChat={
                  owns
                    ? () => void run({ op: "stop", sessionId: session.id })
                    : undefined
                }
                hasMoreBefore={data.history?.hasMoreBefore}
                onLoadEarlier={() => void workspace.loadEarlier()}
                onProviderApprovalAction={(approvalId, decision) => {
                  const pending = approvals.find((p) => p.id === approvalId);
                  if (pending && decision !== "allow-project")
                    decide(approvalId, pending.kind, decision, pending.turnId);
                }}
                onMutationApprovalAction={(approvalId, decision) =>
                  decide(approvalId, "mutation", decision)
                }
                questionState={{
                  resolvedId: view.resolvedQuestions[session.id],
                  onResolve: (id) => {
                    if (owns)
                      setView((previous) => ({
                        ...previous,
                        resolvedQuestions: {
                          ...previous.resolvedQuestions,
                          [session.id]: id,
                        },
                      }));
                  },
                }}
              />
            </ChatFileActionsContext.Provider>
          </div>
          {side}
        </div>
      )}
    </div>
  );
}
