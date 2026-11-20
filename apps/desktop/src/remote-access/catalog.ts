import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@gyro-dev/ui";
import { RemoteHostClient, type NativePorts } from "./client";
import type { HostEvent, Peer, Project } from "./types";

export type RemoteSelection = {
  hostId: string;
  projectId?: string;
  sessionId?: string;
  draft?: string;
};
const HOST_PROBE_INTERVAL_MS = 10_000;
const MAX_SESSION_CATALOG_AGE_MS = 15_000;

type RemoteSession = Session & { running?: boolean };
export type RemoteCatalog = {
  host: Peer;
  projects: Array<{
    project: Project;
    sessions: RemoteSession[];
  }>;
  online: boolean;
  loading: boolean;
  error?: string;
};

/** Catalogs never enter local session/provider state. IDs remain scoped to a host. */
export function useRemoteCatalog(ports: NativePorts, peers: Peer[]) {
  const [catalogs, setCatalogs] = useState<RemoteCatalog[]>([]);
  const catalogsRef = useRef(catalogs);
  catalogsRef.current = catalogs;
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const peerKey = peers
    .map((p) => JSON.stringify([p.id, p.role, p.name, p.transport]))
    .sort()
    .join(",");
  const refreshRef = useRef<(hostId?: string) => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    const hosts = peersRef.current;
    if (hosts.length === 0) {
      setCatalogs((current) => current.length ? [] : current);
      refreshRef.current = async () => {};
      return;
    }
    const onlineHostIds = new Set(
      catalogsRef.current.filter((c) => c.online).map((c) => c.host.id),
    );
    setCatalogs((old) =>
      hosts.map((host) => {
        const previous = old.find((c) => c.host.id === host.id);
        return previous
          ? { ...previous, host }
          : { host, projects: [], online: false, loading: true };
      }),
    );
    const refreshers = hosts.map((host) => {
      const client = new RemoteHostClient(host.id, ports, { catalog: true });
      const update = (apply: (catalog: RemoteCatalog) => RemoteCatalog) =>
        setCatalogs((old) =>
          old.map((c) => (c.host.id === host.id ? apply(c) : c)),
        );
      let pendingProjects: Project[] | undefined;
      let reachable = onlineHostIds.has(host.id);
      let connectionEpoch = 0;
      let checking = false;
      let queuedCheck: "probe" | "refresh" | undefined;
      let loadingSessions = false;
      let sessionRefreshAt = 0;
      let projectCatalogKey: string | undefined;

      const refreshSessions = async () => {
        if (disposed || loadingSessions || !pendingProjects) return;
        const shared = pendingProjects;
        pendingProjects = undefined;
        const epoch = connectionEpoch;
        loadingSessions = true;
        sessionRefreshAt = Date.now();
        const results = await Promise.allSettled(
          shared.map((project) =>
            client.request<RemoteSession[]>({
              op: "sessions",
              projectId: project.id,
            }),
          ),
        );
        loadingSessions = false;
        // A completed batch from before a failed probe cannot revive a host.
        if (!disposed && epoch === connectionEpoch) {
          update((c) => ({
            host,
            online: true,
            loading: false,
            projects: shared.map((project, index) => {
              const result = results[index];
              const sessions =
                result?.status === "fulfilled"
                  ? result.value
                  : (c.projects.find((p) => p.project.id === project.id)
                      ?.sessions ?? []);
              return { project, sessions };
            }),
            error: results.some((r) => r.status === "rejected")
              ? "Some projects could not be refreshed. Showing their last known sessions."
              : undefined,
          }));
        }
        void refreshSessions();
      };

      const check = async (mode: "probe" | "refresh") => {
        if (disposed) return;
        if (checking) {
          if (mode === "refresh" || !queuedCheck) queuedCheck = mode;
          return;
        }
        checking = true;
        try {
          // The handshake can dial or redial the host while its rows are hidden.
          if (!reachable) await client.capabilities();
          const shared = await client.request<Project[]>({ op: "projects" });
          if (disposed) return;
          const nextCatalogKey = JSON.stringify(shared);
          // Unopened chats have no live watcher. Allow an idle probe to skip
          // listing sessions, then refresh before sidebar status grows stale.
          const refreshListings =
            mode === "refresh" ||
            !reachable ||
            nextCatalogKey !== projectCatalogKey ||
            Date.now() - sessionRefreshAt >= MAX_SESSION_CATALOG_AGE_MS;
          reachable = true;
          projectCatalogKey = nextCatalogKey;
          if (refreshListings) {
            pendingProjects = shared;
            void refreshSessions();
          }
        } catch {
          if (disposed) return;
          reachable = false;
          connectionEpoch++;
          pendingProjects = undefined;
          update((c) => ({
            ...c,
            online: false,
            loading: false,
            error: `${host.name} is unavailable. Keep Gyro open on both Macs.`,
          }));
        } finally {
          checking = false;
          if (queuedCheck) {
            const next = queuedCheck;
            queuedCheck = undefined;
            void check(next);
          }
        }
      };
      return { id: host.id, client, check };
    });
    const refresh = async (
      hostIds?: ReadonlySet<string>,
      mode: "probe" | "refresh" = "refresh",
    ) => {
      await Promise.all(
        refreshers
          .filter(({ id }) => !hostIds || hostIds.has(id))
          .map(({ check }) => check(mode)),
      );
    };
    refreshRef.current = (hostId) => refresh(hostId ? new Set([hostId]) : undefined);
    void refresh();
    const timer = setInterval(
      () => void refresh(undefined, "probe"),
      HOST_PROBE_INTERVAL_MS,
    );
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const changedHosts = new Set<string>();
    let unlisten: (() => void) | undefined;
    if (ports.listen)
      void ports
        .listen<{ hostId: string; event: HostEvent }>(
          "gyro://remote-host-event",
          ({ payload }) => {
            const { topic, payload: event } = payload.event;
            const streamClosed =
              topic === "resync" && event?.streamClosed === true;
            const providerChanged =
              topic === "provider" &&
              ["started", "completed", "failed", "cancelled"].includes(
                String(event?.phase),
              );
            if (!streamClosed && topic !== "refresh" && !providerChanged)
              return;
            clearTimeout(eventTimer);
            changedHosts.add(payload.hostId);
            eventTimer = setTimeout(() => {
              const scope = new Set(changedHosts);
              changedHosts.clear();
              void refresh(scope);
            }, 250);
          },
        )
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(eventTimer);
      unlisten?.();
      for (const { client } of refreshers) client.dispose();
    };
  }, [peerKey, ports]);
  const refresh = useCallback((hostId?: string) => refreshRef.current(hostId), []);
  return { catalogs, refresh };
}
