/** Explicit browser fixture only. Never imported by the native application. */
import type {
  Session,
  SessionEvent,
  ProviderChatStreamEvent,
} from "@gyro-dev/ui";
import type { NativePorts } from "./client";
import type {
  AccessStatus,
  HostEvent,
  HostRequest,
  Snapshot,
  TerminalSnapshot,
  SshOptions,
} from "./types";
const hostId = "fixture-host";
const clientId = "fixture-client";
const createdAt = "2026-11-13T10:00:00Z";
const makeSession = (id: string, title: string): Session => ({
  id,
  title,
  workspacePath: "/fixture/remote-project",
  origin: "desktop",
  createdAt,
  updatedAt: createdAt,
  eventsPath: "fixture://events",
  providerId: "openai",
  modelId: "gpt-6.1",
});
export function createPreviewPorts() {
  const status: AccessStatus = {
    settings: { enabled: false, name: "Fixture Mac" },
    sshHosts: [],
    sshHostingActive: false,
    sshClientId: "ssh:fixture-client",
    deviceId: clientId,
    peers: [{ id: hostId, name: "Remote Mac · Fixture", role: "host" }],
    pending: [],
    invitationActive: false,
    projects: [],
    controls: {},
  };
  const syncedProjects: unknown[] = [];
  const sessions = [makeSession("existing-chat", "Existing remote chat")];
  const histories = new Map<string, SessionEvent[]>([
    [
      "existing-chat",
      [
        {
          id: "initial-message",
          sessionId: "existing-chat",
          kind: "assistant-message",
          createdAt,
          message:
            "This is an explicit browser fixture of a remote coding session.",
          payload: {},
        },
      ],
    ],
  ]);
  const listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  const files = new Map([
    ["src/main.ts", "export const greeting = 'hello';\n"],
  ]);
  const terminals: TerminalSnapshot[] = [];
  const receipts = new Map<string, unknown>();
  let generation = 0;
  let online = true;
  let watchId: unknown;
  let control: Snapshot["control"] = { owner: "local", generation: 1 };
  const running = new Set<string>();
  const frames = new Map<string, ProviderChatStreamEvent[]>();
  const requests: HostRequest[] = [];
  let watchedSession: string | undefined;
  let watchedHost = hostId;
  let approvals: Snapshot["approvals"] = [];
  let mutations: Snapshot["mutations"] = [];
  function emit(
    sessionId: string,
    topic: HostEvent["topic"],
    payload: HostEvent["payload"],
  ) {
    if (sessionId !== watchedSession) return;
    for (const handler of listeners.get("gyro://remote-host-event") ?? [])
      handler({
        payload: {
          hostId: watchedHost,
          watchId,
          event: { sessionId, topic, payload },
        },
      });
  }
  const port: NativePorts = {
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      if (command === "remote_access_status")
        return structuredClone(status) as T;
      if (command === "remote_host_watch") {
        if (args?.sessionId) {
          watchId = args.watchId;
          watchedSession = String(args.sessionId);
          watchedHost = String(args.hostId);
        } else if (args?.watchId === watchId) watchedSession = undefined;
        return undefined as T;
      }
      if (command === "remote_access_action") {
        const request = args?.request as Record<string, unknown>;
        if (request.action === "sshHosts")
          return ["fixture-ssh-host", "fixture-offline"] as T;
        if (request.action === "sshConnect") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const existing = status.sshHosts?.find(
            (h) => h.id === request.hostId,
          );
          const options = existing?.options ?? (request.options as SshOptions);
          if (options.host === "fixture-offline")
            throw new Error(
              "SSH connection refused (explicit browser fixture)",
            );
          const id = existing?.id ?? "ssh:fixture-host";
          status.sshHosts = [
            { id, name: "SSH Mac · Fixture", options, connected: true },
          ];
          status.peers = [
            ...status.peers.filter((p) => p.id !== id),
            { id, name: "SSH Mac · Fixture", role: "host", transport: "ssh" },
          ];
          return {
            id,
            name: "SSH Mac · Fixture",
            role: "host",
            transport: "ssh",
          } as T;
        }
        if (
          request.action === "sshDisconnect" ||
          request.action === "sshRemove"
        ) {
          if (request.action === "sshRemove") {
            status.sshHosts = status.sshHosts?.filter(
              (h) => h.id !== request.hostId,
            );
            status.peers = status.peers.filter((p) => p.id !== request.hostId);
          } else
            status.sshHosts = status.sshHosts?.map((h) =>
              h.id === request.hostId ? { ...h, connected: false } : h,
            );
          return undefined as T;
        }
        if (request.action === "configure")
          status.settings = {
            name: String(request.name),
            enabled: Boolean(request.enabled),
          };
        if (request.action === "syncProjects") {
          syncedProjects.push(request.projects);
          status.projects = (
            request.projects as Array<{ path: string; name: string }>
          ).map((p, i) => ({ ...p, id: `local-${i}` }));
        }
        if (request.action === "cancelInvitation")
          status.invitationActive = false;
        if (request.action === "invite") {
          status.invitationActive = true;
          return {
            invitation: "gyro-pair-v1:EXPLICIT-BROWSER-FIXTURE",
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          } as T;
        }
        if (request.action === "revoke")
          status.peers = status.peers.filter(
            (peer) => peer.id !== request.peerId,
          );
        if (request.action === "approve" || request.action === "reject") {
          const peer = status.pending.find((p) => p.id === request.peerId);
          status.pending = status.pending.filter((p) => p !== peer);
          if (peer && request.action === "approve")
            status.peers.push({ ...peer, role: "both" });
        }
        if (request.action === "pair")
          return { hostId, peerId: clientId, status: "pending" } as T;
        if (request.action === "pairStatus") return { status: "approved" } as T;
        return structuredClone(status) as T;
      }
      if (command !== "remote_host_request")
        throw new Error(`Fixture rejected local command: ${command}`);
      if (!online) throw new Error("Host unavailable (fixture)");
      if (!args) throw new Error("Fixture request requires arguments");
      if (
        args?.hostId !== hostId &&
        !status.sshHosts?.some((h) => h.id === args?.hostId && h.connected)
      )
        throw new Error("Wrong or disconnected fixture host");
      const request = args.request as HostRequest;
      if (receipts.has(request.id))
        return structuredClone(receipts.get(request.id)) as T;
      requests.push(structuredClone(request));
      const op = request.operation;
      let result: unknown;
      switch (op.op) {
        case "hello":
          result = {
            protocol: 1,
            hostId,
            name: "Remote Mac · Fixture",
            experimental: true,
            capabilities: ["liveCatchup", "chat", "files", "git", "terminal"],
            selectedProviderId: "openai",
            fullAccess: true,
            requireCommandApproval: false,
            requireFileEditApproval: false,
            providers: [
              {
                id: "openai",
                displayName: "Fixture provider",
                models: ["gpt-6.1"],
                defaultModelId: "gpt-6.1",
                runtimeStatus: "ready",
              },
            ],
          };
          break;
        case "projects":
          result = [
            {
              id: "project",
              name: "remote-project",
              path: "/fixture/remote-project",
            },
          ];
          break;
        case "requestStatus":
          result = { status: receipts.has(op.requestId) ? "done" : "unknown" };
          break;
        case "sessions":
          result = sessions.map((session) => ({
            ...session,
            running: running.has(session.id),
          }));
          break;
        case "createSession": {
          const session = makeSession(crypto.randomUUID(), op.title);
          sessions.push(session);
          histories.set(session.id, []);
          control = { owner: clientId, generation: ++generation };
          result = { session, control };
          break;
        }
        case "snapshot":
          result = {
            session: sessions.find((s) => s.id === op.sessionId),
            running: running.has(op.sessionId),
            liveEvents: op.includeLiveEvents
              ? (frames.get(op.sessionId) ?? [])
              : undefined,
            providerUsage: {
              providerId: "openai",
              status: "available",
              windows: [
                {
                  id: "five-hour",
                  label: "5 hour",
                  usedPercent: 37,
                  resetsAt: "2026-11-14T20:00:00Z",
                },
                {
                  id: "weekly",
                  label: "Weekly",
                  usedPercent: 62,
                  resetsAt: "2026-11-20T20:00:00Z",
                },
              ],
              fetchedAt: new Date().toISOString(),
            },
            control,
            approvals,
            mutations,
          };
          break;
        case "history":
          result = {
            events: histories.get(op.sessionId) ?? [],
            hasMoreBefore: false,
            unchanged: false,
          };
          break;
        case "claim":
          control = { owner: clientId, generation: ++generation };
          result = control;
          break;
        case "stop":
          if (request.lease !== control?.generation)
            throw new Error("Stale write");
          running.delete(op.sessionId);
          emitFrame(op.sessionId, { phase: "cancelled", status: "cancelled" });
          result = null;
          break;
        case "approval":
          approvals = approvals.filter((a) => a.id !== op.approvalId);
          mutations = mutations.filter((m) => m.id !== op.approvalId);
          result = null;
          emit(op.sessionId, "refresh", null);
          break;
        case "release":
          control = undefined;
          result = null;
          break;
        case "submit": {
          if (request.lease !== control?.generation)
            throw new Error("Control changed (fixture)");
          const event: SessionEvent = {
            id: crypto.randomUUID(),
            sessionId: op.sessionId,
            turnId: op.turnId,
            kind: "user-message",
            createdAt: new Date().toISOString(),
            message: op.message,
            payload: {},
          };
          const reply: SessionEvent = {
            ...event,
            id: crypto.randomUUID(),
            kind: "assistant-message",
            message:
              "Fixture response: the request ran on the selected remote host.",
          };
          histories.set(op.sessionId, [
            ...(histories.get(op.sessionId) ?? []),
            event,
            reply,
          ]);
          result = { accepted: true, event };
          emit(op.sessionId, "refresh", null);
          break;
        }
        case "files":
          result = [...files.keys()].map((path) => ({
            path,
            kind: "file",
            depth: 2,
          }));
          break;
        case "readFile":
          result = {
            path: op.path,
            content: files.get(op.path),
            contentHash: files.get(op.path),
            truncated: false,
            sizeBytes: files.get(op.path)?.length ?? 0,
          };
          break;
        case "writeFile": {
          if (request.lease !== control?.generation)
            throw new Error("Control changed (fixture)");
          if (op.expectedHash !== files.get(op.path))
            throw new Error("File changed since it was read");
          files.set(op.path, op.content);
          result = {
            path: op.path,
            content: op.content,
            contentHash: op.content,
            truncated: false,
            sizeBytes: op.content.length,
          };
          break;
        }
        case "git":
          result =
            op.action === "status"
              ? {
                  revision: "fixture-revision",
                  status: {
                    provider: "git",
                    available: true,
                    branch: "main",
                    ahead: 0,
                    behind: 0,
                    additions: 1,
                    deletions: 0,
                    statsPartial: false,
                    files: [
                      {
                        path: "src/main.ts",
                        state: "modified",
                        staged: false,
                        additions: 1,
                        deletions: 0,
                      },
                    ],
                  },
                }
              : {
                  stdout:
                    "diff --git a/src/main.ts b/src/main.ts\n+export const greeting = 'hello';\n",
                };
          break;
        case "terminal": {
          if (op.action === "create") {
            const terminal: TerminalSnapshot = {
              paneId: crypto.randomUUID(),
              title: "Remote terminal · Fixture",
              status: "running",
              output: "$ Ready on remote fixture\r\n",
              outputRevision: 1,
              outputComplete: false,
              cols: 100,
              rows: 30,
            };
            terminals.push(terminal);
            result = terminal;
          } else if (op.action === "list") result = terminals;
          else {
            const terminal = terminals.find((p) => p.paneId === op.paneId);
            if (terminal && op.input) {
              terminal.output += op.input;
              terminal.outputRevision++;
            }
            result = terminal;
          }
          break;
        }
        case "search":
          result = [...files.keys()]
            .filter((p) => files.get(p)?.includes(op.query))
            .map((path) => ({
              path,
              line: 1,
              column: 1,
              text: files.get(path),
            }));
          break;
        default:
          result = null;
      }
      receipts.set(request.id, structuredClone(result));
      return structuredClone(result) as T;
    },
    async listen<T>(event: string, handler: (event: { payload: T }) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const callback = handler as (event: { payload: unknown }) => void;
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    },
  };
  function emitFrame(
    sessionId: string,
    partial: Partial<ProviderChatStreamEvent>,
  ) {
    const previous = frames.get(sessionId) ?? [];
    const frame = {
      sessionId,
      turnId: `live-${sessionId}`,
      providerId: "openai",
      modelId: "gpt-6.1",
      sequence: previous.length,
      eventId: crypto.randomUUID(),
      ...partial,
    } as ProviderChatStreamEvent;
    frames.set(sessionId, [...previous, frame]);
    emit(sessionId, "provider", frame as unknown as Record<string, unknown>);
  }
  return {
    port,
    syncedProjects,
    requests,
    startHostRun(sessionId = "existing-chat") {
      running.add(sessionId);
      frames.set(sessionId, []);
      histories.set(sessionId, [
        ...(histories.get(sessionId) ?? []),
        {
          id: crypto.randomUUID(),
          sessionId,
          turnId: `live-${sessionId}`,
          kind: "user-message",
          createdAt: new Date().toISOString(),
          message: "Continue work on the host",
          payload: {},
        },
      ]);
      emitFrame(sessionId, { phase: "started", status: "running" });
      emitFrame(sessionId, {
        phase: "delta",
        textDelta: "Started on the Mac Mini. ",
      });
      emitFrame(sessionId, {
        phase: "activity",
        activityId: "host-command",
        activityKind: "command",
        activityLabel: "Running host command",
        activityDetail: "pnpm typecheck",
        activityStatus: "running",
      });
      emitFrame(sessionId, {
        phase: "context-usage",
        contextUsage: {
          inputTokens: 12000,
          outputTokens: 100,
          totalTokens: 12100,
          modelContextWindow: 475000,
        },
      });
    },
    streamText(text: string, sessionId = "existing-chat") {
      emitFrame(sessionId, { phase: "delta", textDelta: text });
    },
    setOnline(value: boolean) {
      online = value;
    },
    /** Fixture-only: a device asking this Mac to trust it. */
    addPending(name: string) {
      status.invitationActive = false;
      status.pending.push({
        id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        name,
        role: "client",
      });
    },
    addApproval(command: string, cwd = "/fixture/remote-project") {
      approvals = [
        ...approvals,
        {
          id: crypto.randomUUID(),
          turnId: "fixture-turn",
          kind: "provider",
          payload: { command, cwd },
        },
      ];
    },
    addMutation(path: string, content: string) {
      mutations = [
        ...mutations,
        {
          id: crypto.randomUUID(),
          path,
          operation: files.has(path) ? "update" : "create",
          content,
          baseExists: files.has(path),
        },
      ];
    },
    mutateFile() {
      files.set("src/main.ts", "Changed on host\n");
    },
    sessions,
    histories,
  };
}
