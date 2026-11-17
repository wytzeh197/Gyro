import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@gyro-dev/ui";
import { RemoteHostClient, type NativePorts } from "./client";
import type { Peer, Project } from "./types";

export type RemoteSelection = {
  hostId: string;
  projectId?: string;
  sessionId?: string;
  draft?: string;
};
export type RemoteCatalog = {
  host: Peer;
  projects: Array<{
    project: Project;
    sessions: Array<Session & { running?: boolean }>;
  }>;
  online: boolean;
  loading: boolean;
  error?: string;
};

/** Catalogs never enter local session/provider state. IDs remain scoped to a host. */
export function useRemoteCatalog(ports: NativePorts, peers: Peer[]) {
  const [catalogs, setCatalogs] = useState<RemoteCatalog[]>([]);
  const clients = useRef(new Map<string, RemoteHostClient>());
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const peerKey = peers
    .map((p) => JSON.stringify([p.id, p.role, p.name]))
    .sort()
    .join(",");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let queuedAll = false;
    const queuedHosts = new Set<string>();
    const hosts = peersRef.current;
    const ids = new Set(hosts.map((h) => h.id));
    for (const [id, client] of clients.current)
      if (!ids.has(id)) {
        client.dispose();
        clients.current.delete(id);
      }
    setCatalogs((old) =>
      hosts.map((host) => ({
        host,
        projects: old.find((c) => c.host.id === host.id)?.projects ?? [],
        online: false,
        loading: true,
      })),
    );
    const refresh = async (hostIds?: ReadonlySet<string>) => {
      if (disposed) return;
      if (inFlight) {
        if (hostIds) for (const host of hostIds) queuedHosts.add(host);
        else queuedAll = true;
        return;
      }
      inFlight = true;
      try {
        await Promise.all(
          hosts.filter((host) => !hostIds || hostIds.has(host.id)).map(async (host) => {
            let client = clients.current.get(host.id);
            if (!client) {
              client = new RemoteHostClient(host.id, ports);
              clients.current.set(host.id, client);
            }
            try {
              await client.capabilities();
              const shared = await client.request<Project[]>({
                op: "projects",
              });
              const results = await Promise.allSettled(
                shared.map(async (project) => ({
                  project,
                  sessions: await client!.request<
                    Array<Session & { running?: boolean }>
                  >({
                    op: "sessions",
                    projectId: project.id,
                  }),
                })),
              );
              if (!disposed)
                setCatalogs((old) =>
                  old.map((c) =>
                    c.host.id === host.id
                      ? {
                          host, online: true, loading: false,
                          projects: results.map((result, index) => result.status === "fulfilled"
                            ? result.value : c.projects.find((p) => p.project.id === shared[index]!.id) ?? { project: shared[index]!, sessions: [] }),
                          error: results.some((r) => r.status === "rejected") ? "Some projects could not be refreshed. Showing their last known sessions." : undefined,
                        }
                      : c,
                  ),
                );
            } catch {
              if (!disposed)
                setCatalogs((old) =>
                  old.map((c) =>
                    c.host.id === host.id
                      ? {
                          ...c,
                          online: false,
                          loading: false,
                          error: `${host.name} is unavailable. Keep Gyro open on both Macs.`,
                        }
                      : c,
                  ),
                );
            }
          }),
        );
      } finally {
        inFlight = false;
        if (!disposed && (queuedAll || queuedHosts.size)) {
          const scope = queuedAll ? undefined : new Set(queuedHosts);
          queuedAll = false;
          queuedHosts.clear();
          void refresh(scope);
        }
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const changedHosts = new Set<string>();
    let unlisten: (() => void) | undefined;
    if (ports.listen) void ports.listen<{ hostId: string; event: { topic: string; payload?: { phase?: string } } }>("gyro://remote-host-event", ({ payload }) => {
      if (payload.event.topic !== "refresh" && !(payload.event.topic === "provider" &&
        ["started", "completed", "failed", "cancelled"].includes(payload.event.payload?.phase ?? ""))) return;
      clearTimeout(eventTimer);
      changedHosts.add(payload.hostId);
      eventTimer = setTimeout(() => {
        const scope = new Set(changedHosts);
        changedHosts.clear();
        void refresh(scope);
      }, 250);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(eventTimer);
      unlisten?.();
    };
  }, [peerKey, ports]);
  useEffect(
    () => () => {
      for (const c of clients.current.values()) c.dispose();
      clients.current.clear();
    },
    [],
  );
  const refresh = useCallback(() => refreshRef.current(), []);
  return { catalogs, refresh };
}
