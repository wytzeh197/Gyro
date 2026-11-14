import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RemoteAccessSlots } from "../../../../packages/ui/src/remote-access-context";
import { RemoteAccessContext } from "./context";
import type { AccessStatus, Peer } from "./types";
import type { NativePorts } from "./client";
import { nativePorts } from "./ports";
import "./remote-access.css";
import { useRemoteCatalog, type RemoteSelection } from "./catalog";
import { RemoteNavigation } from "./navigation";

const Settings = lazy(() => import("./settings"));
const Workspace = lazy(() => import("./workspace"));
const native = () => "__TAURI_INTERNALS__" in window;
function fallback() {
  return <p role="status">Loading remote access…</p>;
}
export function RemoteWorkspaceRoot({
  children,
  ports: suppliedPorts,
}: {
  children: ReactNode;
  ports?: NativePorts;
}) {
  const ports = suppliedPorts ?? nativePorts;
  const [status, setStatus] = useState<AccessStatus>();
  const [error, setError] = useState<string>();
  const [selectedHost, setSelectedHost] = useState<Peer>();
  const [selection, setSelection] = useState<RemoteSelection>();
  const peers = status?.peers ?? [];
  const { catalogs, refresh: refreshCatalog } = useRemoteCatalog(
    ports,
    status?.settings.enabled ? peers : [],
  );
  const refreshSequence = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(async () => {
    if (!native() && !suppliedPorts) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await ports.invoke<AccessStatus>("remote_access_status");
      if (sequence === refreshSequence.current) {
        setStatus(next);
        setError(undefined);
      }
    } catch {
      if (sequence === refreshSequence.current)
        setError("Remote access settings are unavailable. Try again.");
    }
  }, [ports, suppliedPorts]);
  const action = useCallback(
    async <T,>(request: Record<string, unknown>) => {
      if (!native() && !suppliedPorts)
        throw new Error("Remote access requires the native Gyro app");
      const result = await ports.invoke<T>("remote_access_action", { request });
      await refresh();
      return result;
    },
    [refresh, ports, suppliedPorts],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (native() || suppliedPorts)
      void ports
        .listen("gyro://remote-access-changed", () => void refresh())
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
    return () => {
      disposed = true;
      clearInterval(timer);
      unlisten?.();
    };
  }, [refresh, ports, suppliedPorts]);
  useEffect(() => {
    if (settingsOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [settingsOpen]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const selectHost = useCallback((host?: Peer) => {
    setSelectedHost(host);
    setSelection(host ? { hostId: host.id } : undefined);
    setSettingsOpen(false);
  }, []);
  const selectRemote = useCallback((next: RemoteSelection) => {
    setSelection(next);
    setSettingsOpen(false);
  }, []);
  const selectLocal = useCallback(() => setSelection(undefined), []);
  const projectSyncKey = useRef<string>();
  const requestedProjects = useRef<Array<{ path: string; name: string }>>();
  const syncProjects = useCallback(
    (projects: Array<{ path: string; name: string }>) => {
      if (!native() && !suppliedPorts) return;
      requestedProjects.current = projects;
      const key = JSON.stringify(projects);
      if (projectSyncKey.current === key) return;
      projectSyncKey.current = key;
      void action({ action: "syncProjects", projects }).catch(() => {
        if (projectSyncKey.current === key) projectSyncKey.current = undefined;
        setError(
          "Sidebar projects could not be shared. Try again in Remote access settings.",
        );
      });
    },
    [action, suppliedPorts],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (requestedProjects.current) syncProjects(requestedProjects.current);
    }, 5000);
    return () => clearInterval(timer);
  }, [syncProjects]);
  const activeHost = status?.settings.enabled
    ? peers.find((p) => p.id === selection?.hostId)
    : undefined;
  useEffect(() => {
    if (selection && status && !activeHost) selectLocal();
  }, [selection, status, activeHost, selectLocal]);
  useEffect(() => {
    if (!selection) return;
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) return;
      if (event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        selectRemote({
          hostId: selection.hostId,
          projectId: selection.projectId,
        });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [selection, openSettings, selectRemote]);
  const context = useMemo(
    () => ({
      ports,
      status,
      error,
      selectedHost,
      selectHost,
      refresh,
      action,
      openSettings,
      selectRemote,
      refreshCatalog,
      connectedHostIds: catalogs.filter((c) => c.online).map((c) => c.host.id),
    }),
    [
      ports,
      status,
      error,
      selectedHost,
      selectHost,
      refresh,
      action,
      openSettings,
      selectRemote,
      refreshCatalog,
      catalogs,
    ],
  );
  const settings = (
    <Suspense fallback={fallback()}>
      <Settings />
    </Suspense>
  );
  return (
    <RemoteAccessContext.Provider value={context}>
      <RemoteAccessSlots.Provider
        value={{
          settings,
          selectLocal,
          syncProjects,
          projects: (
            <RemoteNavigation
              catalogs={catalogs}
              selection={selection}
              onSelect={selectRemote}
            />
          ),
          content:
            activeHost && selection ? (
              <Suspense fallback={fallback()}>
                <Workspace
                  key={activeHost.id}
                  host={activeHost}
                  selection={selection}
                />
              </Suspense>
            ) : undefined,
        }}
      >
        {children}
        <dialog
          className="gyro-remote-dialog"
          ref={dialog}
          aria-labelledby="gyro-remote-settings-title"
          onClose={() => setSettingsOpen(false)}
          onCancel={() => setSettingsOpen(false)}
        >
          <header className="gyro-remote-dialog-header">
            <h2 id="gyro-remote-settings-title" className="gyro-sr-only">
              Remote access
            </h2>
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => setSettingsOpen(false)}
            >
              Close
            </button>
          </header>
          <div className="gyro-settings-surface is-minimal-settings">
            {settingsOpen ? settings : null}
          </div>
        </dialog>
      </RemoteAccessSlots.Provider>
    </RemoteAccessContext.Provider>
  );
}
