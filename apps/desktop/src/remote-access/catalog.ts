import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@gyro-dev/ui";
import { RemoteHostClient, type NativePorts } from "./client";
import type { Peer, Project } from "./types";

export type RemoteSelection = {
  hostId: string;
  projectId?: string;
  sessionId?: string;
};
export type RemoteCatalog = {
  host: Peer;
  projects: Array<{ project: Project; sessions: Session[] }>;
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
    .map((p) => `${p.id}:${p.role}`)
    .sort()
    .join(",");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
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
    const refresh = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        await Promise.all(
          hosts.map(async (host) => {
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
              const projects = await Promise.all(
                shared.map(async (project) => ({
                  project,
                  sessions: await client!.request<Session[]>({
                    op: "sessions",
                    projectId: project.id,
                  }),
                })),
              );
              if (!disposed)
                setCatalogs((old) =>
                  old.map((c) =>
                    c.host.id === host.id
                      ? { host, projects, online: true, loading: false }
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
      }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
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
