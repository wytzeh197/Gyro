import { mergeTerminalUpdate } from "./terminal-stream";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachment,
  ProviderChatStreamEvent,
  Session,
  SessionEvent,
} from "@gyro-dev/ui";
import { applyProviderChatStreamEvent } from "../app-state";
import { createProviderStreamDispatcher } from "../provider-stream-dispatcher";
import { applyProviderChatStreamPresentation } from "../provider-stream-events";
import { mergeSessionHistoryPages } from "../session-event-order";
import { reconcileRemoteHistory } from "./history";
import { RemoteHostClient } from "./client";
import { clearRemoteAttachments } from "./attachments";
import { useRemoteAccess } from "./context";
import { readView, persistViewAsync, hydrateView, mergeHydratedBuffers, rememberView, pendingSubmitOutcome } from "./view-state";
import type { RemoteView } from "./view-state";
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

import type { RemoteSelection } from "./catalog";

export function useRemoteWorkspace(
  hostId: string,
  selection?: RemoteSelection,
) {
  const access = useRemoteAccess();
  const client = useMemo(
    () => new RemoteHostClient(hostId, access.ports),
    [hostId, access.ports],
  );
  const hydrationSeenBuffers = useRef<Set<string>>();
  const [view, updateView] = useState(() => ({
    ...readView(hostId),
    ...(selection
      ? {
          projectId: selection.projectId ?? readView(hostId).projectId,
          sessionId: selection.sessionId,
          panel: "chat" as const,
        }
      : {}),
  }));
  const setView = useCallback((update: React.SetStateAction<RemoteView>) => {
    updateView((current) => {
      if (hydrationSeenBuffers.current)
        for (const id of Object.keys(current.buffers)) hydrationSeenBuffers.current.add(id);
      return typeof update === "function" ? update(current) : update;
    });
  }, []);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [storageWarning, setStorageWarning] = useState(false);
  const [buffersLoaded, setBuffersLoaded] = useState(false);
  const storageReady = useRef<ReturnType<typeof hydrateView>>();
  const [streamEpoch, setStreamEpoch] = useState(0);
  const mounted = useRef(true);
  const viewRef = useRef(view);
  viewRef.current = view;
  const optimistic = useRef(new Map<string, SessionEvent[]>());
  const refreshInFlight = useRef(false);
  const refreshRequested = useRef(false);
  const toolsInFlight = useRef(false);
  // Which session/panel pair has finished its first load; polling after that
  // refreshes in place instead of flashing a loading state.
  const [toolsLoadedFor, setToolsLoadedFor] = useState<string>();
  const metadataCache = useRef<{ at: number; info: HostInfo; projects: Project[]; sessions: Session[]; projectId?: string }>();
  const historyRevisions = useRef(new Map<string, string>());
  const persistedHistory = useRef<SessionEvent[]>([]);
  const terminalCache = useRef(new Map<string, TerminalSnapshot>());
  const generation = useRef(0);
  const fileReadGeneration = useRef(0);
  const earlierLoaded = useRef(false);
  const sessionId = view.sessionId;
  // Trusted, connected devices can act without a manual control step.
  const canAct = online;
  const inFlightSubmits = useRef(new Set<string>());
  const streamOrder = useRef(new Map());
  const streamRevision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      if (buffersLoaded) void persistViewAsync(hostId, viewRef.current);
      mounted.current = false;
      generation.current++;
      queueMicrotask(() => {
        if (!mounted.current) client.dispose();
      });
    };
  }, [client]);
  useEffect(() => {
    let cancelled = false;
    const initialBuffers = new Set(Object.keys(viewRef.current.buffers));
    hydrationSeenBuffers.current = initialBuffers;
    const ready = hydrateView(hostId);
    storageReady.current = ready;
    void ready.then((stored) => {
      if (cancelled) return;
      setView((current) => {
        const buffers = mergeHydratedBuffers(stored.buffers, current.buffers, initialBuffers);
        return { ...current, buffers };
      });
      setBuffersLoaded(true);
    }).catch(() => {
      if (storageReady.current === ready) storageReady.current = undefined;
      if (hydrationSeenBuffers.current === initialBuffers)
        hydrationSeenBuffers.current = undefined;
      if (!cancelled) setStorageWarning(true);
    });
    return () => {
      cancelled = true;
      if (hydrationSeenBuffers.current === initialBuffers)
        hydrationSeenBuffers.current = undefined;
    };
  }, [hostId]);
  useEffect(() => {
    rememberView(hostId, view);
    if (!buffersLoaded) return;
    hydrationSeenBuffers.current = undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void persistViewAsync(hostId, view).then((saved) => { if (!cancelled) setStorageWarning(!saved); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [hostId, view, buffersLoaded]);
  useEffect(() => {
    if (!buffersLoaded) return;
    const flush = () => { void persistViewAsync(hostId, viewRef.current); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [hostId, buffersLoaded]);
  const fail = useCallback((reason: unknown) => {
    if (!mounted.current) return;
    const message = String(reason);
    setError(message);
    if (
      /Host unavailable|not trusted|revoked|not paired|connection.*closed|SSH host is disconnected/i.test(
        message,
      )
    )
      setOnline(false);
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) {
      refreshRequested.current = true;
      return;
    }
    refreshInFlight.current = true;
    const current = generation.current;
    const selected = viewRef.current;
    try {
      let metadata = metadataCache.current;
      if (!metadata || Date.now() - metadata.at > 10_000 || metadata.projectId !== selected.projectId) {
        const info = await client.capabilities();
        if (info.protocol !== 1) throw new Error("Update Gyro on both Macs to use remote access");
        const projects = await client.request<Project[]>({ op: "projects" });
        const projectId = projects.some((p) => p.id === selected.projectId) ? selected.projectId : projects[0]?.id;
        const sessions = projectId ? await client.request<Session[]>({ op: "sessions", projectId }) : [];
        metadata = { at: Date.now(), info, projects, projectId, sessions };
        metadataCache.current = metadata;
      }
      const { info, projects, projectId, sessions } = metadata;
      if (!mounted.current || current !== generation.current) return;
      setOnline(true);
      setLoading(false);
      setData((previous) => previous.info === info && previous.projects === projects && previous.sessions === sessions
        ? previous : { ...previous, info, projects, sessions });
      if (projectId !== selected.projectId) {
        setView((previous) => ({
          ...previous,
          projectId,
          sessionId: undefined,
        }));
        return;
      }
      if (!selected.sessionId) return;
      const beforeStream = streamRevision.current;
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
      if (
        snapshot.control?.owner !==
        (hostId.startsWith("ssh:")
          ? access.status?.sshClientId
          : access.status?.deviceId)
      )
        client.forgetControl(selected.sessionId);
      if (history.revision)
        historyRevisions.current.set(selected.sessionId, history.revision);
      setData((previous) => ({
        ...previous,
        snapshot:
          beforeStream === streamRevision.current
            ? snapshot
            : {
                ...snapshot,
                running: previous.snapshot?.running ?? snapshot.running,
              },
        history:
          history.unchanged && previous.history
            ? previous.history
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
        if (
          !mounted.current ||
          current !== generation.current ||
          viewRef.current.sessionId !== selected.sessionId
        )
          return;
        const recorded = history.events.some(
          (event) =>
            event.turnId === pending.turnId && event.kind === "user-message",
        );
        const outcome = pendingSubmitOutcome(pending, {
          recorded,
          status: receipt.status,
          inFlight: inFlightSubmits.current.has(pending.requestId),
          now: Date.now(),
        });
        if (outcome === "ran" && Array.isArray(pending.attachmentIds))
          clearRemoteAttachments(hostId, selected.sessionId, pending.attachmentIds);
        if (outcome !== "wait")
          setView((previous) => {
            if (
              previous.pendingSubmissions[selected.sessionId!]?.requestId !==
              pending.requestId
            )
              return previous;
            const remaining = { ...previous.pendingSubmissions };
            delete remaining[selected.sessionId!];
            return {
              ...previous,
              pendingSubmissions: remaining,
              drafts:
                outcome === "ran"
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
      // Never feed the rendered live rows back into the durable history.
      // Their IDs differ from saved activity IDs and would duplicate each call.
      persistedHistory.current = mergeSessionHistoryPages(
        persistedHistory.current,
        history.events,
      );
      const persisted = persistedHistory.current;
      const live =
        snapshot.running || beforeStream !== streamRevision.current
          ? optimistic.current.get(selected.sessionId!)
          : undefined;
      setEvents((previous) => reconcileRemoteHistory(previous, persisted, live));
      if (!snapshot.running && beforeStream === streamRevision.current)
        optimistic.current.delete(selected.sessionId);
    } catch (reason) {
      fail(reason);
      setOnline(false);
      setLoading(false);
    } finally {
      refreshInFlight.current = false;
      if (refreshRequested.current && mounted.current) {
        refreshRequested.current = false;
        queueMicrotask(() => void load());
      }
    }
  }, [
    client,
    hostId,
    access.status?.deviceId,
    access.status?.sshClientId,
    fail,
  ]);
  useEffect(() => {
    generation.current++;
    earlierLoaded.current = false;
    // Revisions are valid only while their transcript is retained. Switching
    // clears the persisted events below, so re-fetch the selected chat's body
    // instead of accepting an empty "unchanged" response from the host.
    historyRevisions.current.clear();
    persistedHistory.current = [];
    setEvents(optimistic.current.get(sessionId ?? "") ?? []);
    setData((previous) => ({
      ...previous,
      snapshot: undefined,
      history: undefined,
      files: [],
      git: undefined,
      terminals: [],
    }));
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [view.projectId, sessionId, load]);
  useEffect(() => {
    if (!sessionId || !online) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    const dispatcher = createProviderStreamDispatcher(
      streamOrder.current,
      (event) => {
        if (!disposed && viewRef.current.sessionId === event.sessionId) {
          streamRevision.current++;
          const active = ["started", "delta", "activity", "heartbeat"].includes(
            event.phase,
          );
          const settled = ["completed", "failed", "cancelled"].includes(
            event.phase,
          );
          if (active || settled)
            setData((previous) => previous.snapshot?.session.id === event.sessionId && previous.snapshot.running !== active
              ? { ...previous, snapshot: { ...previous.snapshot, running: active } } : previous);
          applyProviderChatStreamEvent(optimistic, setEvents, event);
          applyProviderChatStreamPresentation(optimistic, setEvents, event);
        }
      },
    );
    void client
      .subscribe(sessionId, (event) => {
        if (disposed) return;
        if (event.topic === "resync") {
          clearTimeout(reconnectTimer);
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) setStreamEpoch((value) => value + 1);
          }, 1000);
        }
        if (event.topic === "terminal" && event.payload) {
          const snapshot = event.payload.snapshot as TerminalSnapshot;
          const merged = mergeTerminalUpdate(terminalCache.current.get(snapshot.paneId), snapshot);
          if (merged) {
            terminalCache.current.set(snapshot.paneId, merged);
            setData((previous) => ({ ...previous, terminals: previous.terminals.some((pane) => pane.paneId === merged.paneId)
              ? previous.terminals.map((pane) => pane.paneId === merged.paneId ? merged : pane)
              : [...previous.terminals, merged] }));
          } else void loadToolsRef.current();
          return;
        }
        if (event.topic === "checkpoint" && event.payload) {
          const frames = event.payload.events as unknown as ProviderChatStreamEvent[];
          const turns = new Set(frames.map((frame) => frame.turnId));
          const keep = (items: SessionEvent[]) => items.filter((item) =>
            !turns.has(item.turnId) || !(item.kind === "assistant-message" ||
              (item.kind === "system-event" && String((item.payload as Record<string, unknown>)?.kind ?? "").startsWith("provider-"))));
          optimistic.current.set(sessionId, keep(optimistic.current.get(sessionId) ?? []));
          setEvents(keep);
          for (const frame of frames) {
            applyProviderChatStreamEvent(optimistic, setEvents, frame);
            applyProviderChatStreamPresentation(optimistic, setEvents, frame);
            streamOrder.current.set(`${sessionId}:${frame.turnId ?? "turn"}`, {
              nextSequence: frame.sequence + 1, pending: new Map(),
              terminal: ["completed", "failed", "cancelled"].includes(frame.phase),
            });
          }
          if (event.payload.truncated) setError("This live response exceeds the catch-up limit. Complete history will appear when the turn finishes.");
        }
        if (event.topic === "provider" && event.payload)
          dispatcher.push(event.payload as unknown as ProviderChatStreamEvent);
        const phase = event.payload?.phase;
        const invalidates = event.topic !== "provider" || ["started", "activity", "completed", "failed", "cancelled"].includes(String(phase));
        if (invalidates && refreshTimer === undefined)
          refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            void load();
          }, 1000);
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
  const run = useCallback(
    async <T>(
      operation: HostOperation,
      requestId?: string,
      onSend?: () => void,
    ): Promise<T | undefined> => {
      if (!online) {
        setError("Reconnect to the host before acting. Your draft stays here.");
        return;
      }
      setBusy(true);
      setError(undefined);
      const issued = generation.current;
      try {
        if (operation.op === "terminal" && operation.action === "input") {
          const result = await client.input<T>(operation);
          return mounted.current && issued === generation.current ? result : undefined;
        }
        // Claim only for an explicit write, never for watching or a heartbeat.
        // The host still fences delayed writes with the returned generation.
        if (
          "sessionId" in operation &&
          ([
            "renameSession",
            "setModel",
            "attachWorkspaceFile",
            "submit",
            "stop",
            "approval",
            "question",
            "writeFile",
            "path",
          ].includes(operation.op) ||
            (operation.op === "git" &&
              !["status", "diff", "branches"].includes(operation.action)) ||
            (operation.op === "terminal" &&
              !["list", "read"].includes(operation.action)))
        )
          await client.request({ op: "claim", sessionId: operation.sessionId });
        if (!mounted.current || issued !== generation.current) return;
        onSend?.();
        const result = await client.request<T>(operation, requestId);
        if (operation.op === "setModel" && mounted.current && issued === generation.current) {
          const updated = result as Session;
          setData((previous) => ({
            ...previous,
            sessions: previous.sessions.map((session) => session.id === updated.id ? updated : session),
            snapshot: previous.snapshot?.session.id === updated.id
              ? { ...previous.snapshot, session: updated } : previous.snapshot,
          }));
        }
        return mounted.current && issued === generation.current
          ? result
          : undefined;
      } catch (reason) {
        fail(reason);
        return;
      } finally {
        if (mounted.current) {
          setBusy(false);
          if (!(operation.op === "terminal" && ["input", "resize", "read", "list"].includes(operation.action))) {
            metadataCache.current = undefined;
            void load();
          }
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
  useEffect(() => {
    if (!selection) return;
    selectSession(selection.sessionId);
    if (selection.projectId)
      setView((previous) => ({ ...previous, projectId: selection.projectId }));
  }, [selection?.projectId, selection?.sessionId, selectSession]);
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
  const submitting = useRef(false);
  async function submit(
    message: string, model: ModelChoice, attachments: ChatAttachment[] = [],
    mode: "normal" | "plan" = "normal",
  ) {
    if (
      !sessionId ||
      !canAct ||
      busy ||
      submitting.current ||
      data.snapshot?.running ||
      view.pendingSubmissions[sessionId]
    )
      return false;
    message = message.trim() || (attachments.length ? "Please review the attached files." : "");
    if (!message) return false;
    submitting.current = true;
    const issued = generation.current;
    const uploaded: ChatAttachment[] = [];
    let prepared = false;
    try {
      if (attachments.length) {
        if (!data.info?.capabilities.includes("attachments"))
          throw new Error("Update Gyro on the host to send attachments.");
        setBusy(true);
        setError(undefined);
        for (const attachment of attachments) {
          if (attachment.pending) throw new Error("Wait for the attachment to finish preparing.");
          if (attachment.kind === "workspace-file") {
            const prepared = await run<ChatAttachment>({
              op: "attachWorkspaceFile", sessionId,
              path: attachment.relativePath ?? attachment.path,
            });
            if (!prepared) throw new Error("The host could not prepare the project file.");
            uploaded.push(prepared);
          } else {
            uploaded.push(await access.ports.invoke<ChatAttachment>("remote_upload_attachment", {
              hostId, sessionId, attachment,
            }));
          }
        }
      }
      if (!mounted.current || issued !== generation.current) return false;
      prepared = true;
    } catch (reason) {
      fail(reason);
      return false;
    } finally {
      if (mounted.current) setBusy(false);
      if (!prepared) submitting.current = false;
    }
    const currentDraft = view.drafts[sessionId] ?? "";
    const turnId = crypto.randomUUID(),
      requestId = crypto.randomUUID();
    const pendingView = {
      ...viewRef.current,
      pendingSubmissions: {
        ...viewRef.current.pendingSubmissions,
        [sessionId]: { requestId, turnId, message, draft: currentDraft,
          attachmentIds: attachments.map((attachment) => attachment.id), sentAt: Date.now() },
      },
    };
    setView(pendingView);
    let saved = false;
    try {
      // Creating a chat can submit before the first IndexedDB read finishes.
      // Wait for it, rather than mistaking that startup race for a quota error.
      const hydrated = await (storageReady.current ??= hydrateView(hostId));
      setBuffersLoaded(true);
      if (!buffersLoaded && hydrated) pendingView.buffers = { ...hydrated.buffers, ...pendingView.buffers };
      saved = await persistViewAsync(hostId, pendingView);
    } catch { storageReady.current = undefined; /* The next explicit send can retry storage. */ }
    if (!saved) {
      setView((current) => {
        const pendingSubmissions = { ...current.pendingSubmissions };
        delete pendingSubmissions[sessionId];
        const restored = { ...current, pendingSubmissions };
        rememberView(hostId, restored);
        return restored;
      });
      setStorageWarning(true);
      setError("The pending message could not be saved on this Mac. Free storage and retry before sending.");
      submitting.current = false;
      return false;
    }
    let sent = false;
    inFlightSubmits.current.add(requestId);
    const result = await run<{ accepted: boolean; event: SessionEvent }>(
      {
        op: "submit", sessionId, turnId, message, model,
        ...(uploaded.length ? { attachments: uploaded.map((attachment) => ({
          path: attachment.kind === "workspace-file"
            ? attachment.relativePath ?? attachment.path : attachment.path,
          kind: attachment.kind, name: attachment.name,
          contentHash: attachment.contentHash!,
        })) } : {}),
        ...(data.info?.capabilities.includes("chatModes") ? { mode } : {}),
      },
      requestId,
      () => {
        sent = true;
      },
    );
    inFlightSubmits.current.delete(requestId);
    // The submit never left this Mac (offline, or taking control failed), so
    // the host cannot have run it. Unblock the composer and keep the draft.
    if (!sent)
      setView((previous) => {
        if (previous.pendingSubmissions[sessionId]?.requestId !== requestId)
          return previous;
        const pendingSubmissions = { ...previous.pendingSubmissions };
        delete pendingSubmissions[sessionId];
        return { ...previous, pendingSubmissions };
      });
    if (result?.accepted) {
      clearRemoteAttachments(hostId, sessionId, attachments.map((attachment) => attachment.id));
      persistedHistory.current = mergeSessionHistoryPages(
        persistedHistory.current,
        [result.event],
      );
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
    submitting.current = false;
    return Boolean(result?.accepted);
  }
  async function loadEarlier() {
    // UI event IDs remain stable across live/saved reconciliation; the host
    // pagination cursor must always use its original durable event ID.
    const first = persistedHistory.current.find(
      (event) => event.kind !== "session-created",
    );
    if (!sessionId || !first) return;
    const issued = generation.current;
    const page = await run<History>({
      op: "history",
      sessionId,
      before: first.id,
    });
    if (
      page &&
      mounted.current &&
      issued === generation.current &&
      viewRef.current.sessionId === sessionId
    ) {
      earlierLoaded.current = true;
      persistedHistory.current = mergeSessionHistoryPages(
        page.events,
        persistedHistory.current,
      );
      const persisted = persistedHistory.current;
      setEvents((previous) =>
        reconcileRemoteHistory(
          previous,
          persisted,
          optimistic.current.get(sessionId),
        ),
      );
      setData((previous) => ({ ...previous, history: page }));
    }
  }
  const loadToolsRef = useRef<() => Promise<void>>(async () => {});
  loadToolsRef.current = loadTools;
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
            if (previous && previous.outputRevision === summary.outputRevision && previous.outputCursor?.generation === summary.outputCursor?.generation)
              return { ...previous, ...summary, output: previous.output };
            const read = await client.request<TerminalSnapshot>({
              op: "terminal",
              action: "read",
              sessionId,
              paneId: summary.paneId,
              revision: previous?.outputCursor?.generation === summary.outputCursor?.generation ? previous?.outputRevision : undefined,
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
    const readGeneration = ++fileReadGeneration.current;
    const selectionGeneration = generation.current;
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
    if (file && mounted.current)
      setView((previous) => {
        const key = `${selected}:${relative}`;
        if (readGeneration !== fileReadGeneration.current || selectionGeneration !== generation.current
            || previous.sessionId !== selected || previous.buffers[key] !== existing) return previous;
        return { ...previous, selectedFile: relative, panel: "files",
          buffers: { ...previous.buffers, [key]: { file, text: file.content } } };
      });
  }
  useEffect(() => {
    void loadTools();
    const timer = setInterval(
      () => void loadTools(),
      view.panel === "terminal" && !data.info?.capabilities.includes("terminalPush") ? 1000 : 5000,
    );
    return () => clearInterval(timer);
  }, [view.panel, sessionId, online]);
  async function reconnect() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      metadataCache.current = undefined;
      if (hostId.startsWith("ssh:"))
        await access.action({ action: "sshConnect", hostId });
      await load();
      setStreamEpoch((value) => value + 1);
    } catch (reason) {
      fail(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return {
    client,
    view,
    setView,
    data,
    setData,
    events,
    online,
    canAct,
    busy,
    loading,
    storageWarning,
    error,
    setError,
    run,
    load,
    loadTools,
    reconnect,
    toolsLoading:
      Boolean(sessionId && online) &&
      toolsLoadedFor !== `${sessionId}:${view.panel}`,
    selectSession,
    createSession,
    submit,
    loadEarlier,
    openRemoteFile,
  };
}
export type RemoteWorkspaceController = ReturnType<typeof useRemoteWorkspace>;
