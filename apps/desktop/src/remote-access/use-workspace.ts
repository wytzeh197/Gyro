import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProviderChatStreamEvent,
  Session,
  SessionEvent,
} from "@gyro-dev/ui";
import { applyProviderChatStreamEvent } from "../app-state";
import { createProviderStreamDispatcher } from "../provider-stream-dispatcher";
import {
  mergePersistedAndOptimisticEvents,
  applyProviderChatStreamActivity,
} from "../provider-stream-events";
import { mergeSessionHistoryPages } from "../session-event-order";
import { RemoteHostClient } from "./client";
import { useRemoteAccess } from "./context";
import { readView, persistView } from "./view-state";
import type {
  Control,
  GitSnapshot,
  History,
  HostInfo,
  HostOperation,
  ModelChoice,
  Project,
  Snapshot,
  TerminalSnapshot,
  WorkspaceData,
  // File contents are read only through the selected host.
} from "./types";
import type { WorkspaceFileContent } from "@gyro-dev/ui";

const emptyData = (): WorkspaceData => ({
  projects: [],
  sessions: [],
  files: [],
  terminals: [],
});

export function useRemoteWorkspace(hostId: string) {
  const access = useRemoteAccess();
  const client = useMemo(
    () => new RemoteHostClient(hostId, access.ports),
    [hostId, access.ports],
  );
  const [view, setView] = useState(() => readView(hostId));
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [storageWarning, setStorageWarning] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const mounted = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  const optimistic = useRef(new Map<string, SessionEvent[]>());
  const refreshInFlight = useRef(false);
  const toolsInFlight = useRef(false);
  // Which session/panel pair has finished its first load; polling after that
  // refreshes in place instead of flashing a loading state.
  const [toolsLoadedFor, setToolsLoadedFor] = useState<string>();
  const historyRevisions = useRef(new Map<string, string>());
  const terminalCache = useRef(new Map<string, TerminalSnapshot>());
  const generation = useRef(0);
  const earlierLoaded = useRef(false);
  const sessionId = view.sessionId;
  const owns =
    online &&
    Boolean(
      data.snapshot?.control &&
      data.snapshot.control.owner === access.status?.deviceId,
    );
  useEffect(() => {
    mounted.current = true;
    return () => {
      persistView(hostId, viewRef.current);
      mounted.current = false;
      generation.current++;
      queueMicrotask(() => {
        if (!mounted.current) client.dispose();
      });
    };
  }, [client]);
  useEffect(() => {
    setStorageWarning(!persistView(hostId, view));
  }, [hostId, view]);
  const fail = useCallback((reason: unknown) => {
    if (!mounted.current) return;
    const message = String(reason);
    setError(message);
    if (
      /Host unavailable|not trusted|revoked|not paired|connection.*closed/i.test(
        message,
      )
    )
      setOnline(false);
  }, []);
  const load = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const current = generation.current;
    const selected = viewRef.current;
    try {
      const info = await client.capabilities();
      if (info.protocol !== 1)
        throw new Error("Update Gyro on both Macs to use remote access");
      const projects = await client.request<Project[]>({ op: "projects" });
      const projectId = projects.some((p) => p.id === selected.projectId)
        ? selected.projectId
        : projects[0]?.id;
      const sessions = projectId
        ? await client.request<Session[]>({ op: "sessions", projectId })
        : [];
      if (!mounted.current || current !== generation.current) return;
      setOnline(true);
      setLoading(false);
      setData((previous) => ({ ...previous, info, projects, sessions }));
      if (projectId !== selected.projectId) {
        setView((previous) => ({
          ...previous,
          projectId,
          sessionId: undefined,
        }));
        return;
      }
      if (!selected.sessionId) return;
      const [snapshot, history] = await Promise.all([
        client.request<Snapshot>({
          op: "snapshot",
          sessionId: selected.sessionId,
        }),
        client.request<History>({
          op: "history",
          sessionId: selected.sessionId,
          revision: historyRevisions.current.get(selected.sessionId),
        }),
      ]);
      if (
        !mounted.current ||
        current !== generation.current ||
        viewRef.current.sessionId !== selected.sessionId
      )
        return;
      if (snapshot.control?.owner !== access.status?.deviceId)
        client.forgetControl(selected.sessionId);
      if (history.revision)
        historyRevisions.current.set(selected.sessionId, history.revision);
      setData((previous) => ({
        ...previous,
        snapshot,
        history:
          history.unchanged && previous.history
            ? { ...previous.history, revision: history.revision }
            : {
                ...history,
                hasMoreBefore: earlierLoaded.current
                  ? (previous.history?.hasMoreBefore ?? history.hasMoreBefore)
                  : history.hasMoreBefore,
              },
      }));
      const pending = selected.pendingSubmissions[selected.sessionId];
      if (pending) {
        const receipt = await client.request<{ status: string }>({
          op: "requestStatus",
          requestId: pending.requestId,
        });
        const recorded = history.events.some(
          (event) =>
            event.turnId === pending.turnId && event.kind === "user-message",
        );
        if (
          recorded ||
          receipt.status === "done" ||
          receipt.status === "failed"
        )
          setView((previous) => {
            const remaining = { ...previous.pendingSubmissions };
            delete remaining[selected.sessionId!];
            return {
              ...previous,
              pendingSubmissions: remaining,
              drafts:
                recorded || receipt.status === "done"
                  ? {
                      ...previous.drafts,
                      [selected.sessionId!]:
                        previous.drafts[selected.sessionId!] === pending.draft
                          ? ""
                          : (previous.drafts[selected.sessionId!] ?? ""),
                    }
                  : previous.drafts,
            };
          });
      }
      setEvents((previous) =>
        mergePersistedAndOptimisticEvents(
          mergeSessionHistoryPages(
            previous.filter((e) => e.sessionId === selected.sessionId),
            history.events,
          ),
          snapshot.running
            ? optimistic.current.get(selected.sessionId!)
            : undefined,
        ),
      );
      if (!snapshot.running) optimistic.current.delete(selected.sessionId);
    } catch (reason) {
      fail(reason);
      setOnline(false);
      setLoading(false);
    } finally {
      refreshInFlight.current = false;
    }
  }, [client, access.status?.deviceId, fail]);
  useEffect(() => {
    generation.current++;
    earlierLoaded.current = false;
    setEvents([]);
    setData((previous) => ({
      ...previous,
      snapshot: undefined,
      history: undefined,
      files: [],
      git: undefined,
      terminals: [],
    }));
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [view.projectId, sessionId, load]);
  useEffect(() => {
    if (!sessionId || !online) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    const dispatcher = createProviderStreamDispatcher(new Map(), (event) => {
      if (!disposed && viewRef.current.sessionId === event.sessionId) {
        applyProviderChatStreamEvent(optimistic, setEvents, event);
        applyProviderChatStreamActivity(optimistic, setEvents, event);
      }
    });
    void client
      .subscribe(sessionId, (event) => {
        if (disposed) return;
        if (event.topic === "resync" && event.payload?.streamClosed) {
          clearTimeout(reconnectTimer);
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) setStreamEpoch((value) => value + 1);
          }, 1000);
        }
        if (event.topic === "provider" && event.payload)
          dispatcher.push(event.payload as unknown as ProviderChatStreamEvent);
        if (refreshTimer === undefined)
          refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            void load();
          }, 200);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((reason) => {
        if (disposed) return;
        fail(reason);
        reconnectTimer = window.setTimeout(() => {
          if (!disposed) setStreamEpoch((value) => value + 1);
        }, 2500);
      });
    return () => {
      disposed = true;
      unlisten?.();
      dispatcher.dispose();
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
    };
  }, [client, sessionId, online, load, fail, streamEpoch]);
  useEffect(() => {
    if (!sessionId || !owns) return;
    const timer = setInterval(() => {
      void client
        .request<Control>({ op: "claim", sessionId })
        .then((control) => {
          if (mounted.current && viewRef.current.sessionId === sessionId)
            setData((previous) => ({
              ...previous,
              snapshot: previous.snapshot
                ? { ...previous.snapshot, control }
                : undefined,
            }));
        })
        .catch((reason) => {
          client.forgetControl(sessionId);
          void load();
          fail(reason);
        });
    }, 10000);
    return () => clearInterval(timer);
  }, [client, sessionId, owns, load, fail]);
  const run = useCallback(
    async <T>(
      operation: HostOperation,
      requestId?: string,
    ): Promise<T | undefined> => {
      if (!online) {
        setError("Reconnect to the host before acting. Your draft stays here.");
        return;
      }
      setBusy(true);
      setError(undefined);
      const issued = generation.current;
      try {
        const result = await client.request<T>(operation, requestId);
        return mounted.current && issued === generation.current
          ? result
          : undefined;
      } catch (reason) {
        fail(reason);
        return;
      } finally {
        if (mounted.current) {
          setBusy(false);
          void load();
        }
      }
    },
    [client, online, fail, load],
  );
  const selectSession = useCallback(
    (id?: string) => {
      generation.current++;
      const old = viewRef.current.sessionId;
      if (old && old !== id)
        void client.request({ op: "release", sessionId: old }).catch(() => {});
      setView((previous) => ({ ...previous, sessionId: id, panel: "chat" }));
      setError(undefined);
    },
    [client],
  );
  async function createSession(
    model: ModelChoice,
    branch?: string,
  ): Promise<string | undefined> {
    if (!view.projectId || busy || !online) return undefined;
    const result = await run<{ session: Session; control: Control }>({
      op: "createSession",
      projectId: view.projectId,
      title: "New chat",
      model,
      branch,
    });
    if (result && mounted.current) {
      selectSession(result.session.id);
      setData((previous) => ({
        ...previous,
        sessions: [...previous.sessions, result.session],
        snapshot: {
          session: result.session,
          control: result.control,
          running: false,
          approvals: [],
          mutations: [],
        },
      }));
      return result.session.id;
    }
    return undefined;
  }
  async function claim() {
    if (!sessionId) return;
    const control = await run<Control>({ op: "claim", sessionId });
    if (control)
      setData((previous) => ({
        ...previous,
        snapshot: previous.snapshot
          ? { ...previous.snapshot, control }
          : undefined,
      }));
  }
  async function submit(message: string, model: ModelChoice) {
    if (
      !sessionId ||
      !owns ||
      busy ||
      data.snapshot?.running ||
      view.pendingSubmissions[sessionId]
    )
      return;
    const currentDraft = view.drafts[sessionId] ?? "";
    const turnId = crypto.randomUUID(),
      requestId = crypto.randomUUID();
    setView((previous) => ({
      ...previous,
      pendingSubmissions: {
        ...previous.pendingSubmissions,
        [sessionId]: { requestId, turnId, message, draft: currentDraft },
      },
    }));
    const result = await run<{ accepted: boolean; event: SessionEvent }>(
      { op: "submit", sessionId, turnId, message, model },
      requestId,
    );
    if (result?.accepted) {
      setEvents((previous) =>
        mergeSessionHistoryPages(previous, [result.event]),
      );
      setView((previous) => {
        const pendingSubmissions = { ...previous.pendingSubmissions };
        delete pendingSubmissions[sessionId];
        return {
          ...previous,
          pendingSubmissions,
          drafts: {
            ...previous.drafts,
            [sessionId]:
              previous.drafts[sessionId] === currentDraft
                ? ""
                : (previous.drafts[sessionId] ?? ""),
          },
        };
      });
    }
  }
  async function loadEarlier() {
    const first = events.find((event) => event.kind !== "session-created");
    if (!sessionId || !first) return;
    const page = await run<History>({
      op: "history",
      sessionId,
      before: first.id,
    });
    if (page) {
      earlierLoaded.current = true;
      setEvents((previous) => mergeSessionHistoryPages(page.events, previous));
      setData((previous) => ({ ...previous, history: page }));
    }
  }
  async function loadTools() {
    if (!sessionId || !online || toolsInFlight.current) return;
    toolsInFlight.current = true;
    const panelKey = `${sessionId}:${view.panel}`;
    try {
      if (view.panel === "files") {
        const files = await client.request<WorkspaceData["files"]>({
          op: "files",
          sessionId,
        });
        if (viewRef.current.sessionId === sessionId)
          setData((previous) => ({ ...previous, files }));
      }
      // The normal Environment card needs the host's branch and diff totals.
      if (view.panel === "git" || view.panel === "chat") {
        const git = await client.request<GitSnapshot>({
          op: "git",
          action: "status",
          sessionId,
        });
        if (viewRef.current.sessionId === sessionId)
          setData((previous) => ({ ...previous, git }));
      }
      if (view.panel === "terminal") {
        const summaries = await client.request<TerminalSnapshot[]>({
          op: "terminal",
          action: "list",
          sessionId,
        });
        const terminals = await Promise.all(
          summaries.map(async (summary) => {
            const previous = terminalCache.current.get(summary.paneId);
            if (previous && previous.outputRevision === summary.outputRevision)
              return { ...previous, ...summary, output: previous.output };
            const read = await client.request<TerminalSnapshot>({
              op: "terminal",
              action: "read",
              sessionId,
              paneId: summary.paneId,
              revision: previous?.outputRevision,
            });
            const snapshot = {
              ...read,
              output: read.output ?? previous?.output ?? "",
            };
            terminalCache.current.set(summary.paneId, snapshot);
            return snapshot;
          }),
        );
        if (viewRef.current.sessionId === sessionId)
          setData((previous) => ({ ...previous, terminals }));
      }
    } catch (reason) {
      fail(reason);
    } finally {
      toolsInFlight.current = false;
      setToolsLoadedFor(panelKey);
    }
  }
  async function openRemoteFile(path: string) {
    const selected = viewRef.current.sessionId;
    if (!selected) return;
    const root = data.snapshot?.session.workspacePath.replace(/\/+$/, "");
    const relative =
      path.startsWith("/") && root && path.startsWith(`${root}/`)
        ? path.slice(root.length + 1)
        : path;
    if (relative.startsWith("/")) {
      setError("This file is outside the shared remote project.");
      return;
    }
    const existing = viewRef.current.buffers[`${selected}:${relative}`];
    if (existing) {
      setView((previous) => ({
        ...previous,
        selectedFile: relative,
        panel: "files",
      }));
      return;
    }
    const file = await run<WorkspaceFileContent>({
      op: "readFile",
      sessionId: selected,
      path: relative,
    });
    if (file)
      setView((previous) => ({
        ...previous,
        selectedFile: relative,
        panel: "files",
        buffers: {
          ...previous.buffers,
          [`${selected}:${relative}`]: { file, text: file.content },
        },
      }));
  }
  useEffect(() => {
    void loadTools();
    const timer = setInterval(
      () => void loadTools(),
      view.panel === "terminal" ? 1000 : 5000,
    );
    return () => clearInterval(timer);
  }, [view.panel, sessionId, online]);
  return {
    client,
    view,
    setView,
    data,
    setData,
    events,
    online,
    owns,
    busy,
    loading,
    storageWarning,
    error,
    setError,
    run,
    load,
    loadTools,
    toolsLoading:
      Boolean(sessionId && online) &&
      toolsLoadedFor !== `${sessionId}:${view.panel}`,
    selectSession,
    createSession,
    claim,
    submit,
    loadEarlier,
    openRemoteFile,
  };
}
export type RemoteWorkspaceController = ReturnType<typeof useRemoteWorkspace>;
