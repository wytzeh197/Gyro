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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = useCallback(async () => {
    if (!native() && !suppliedPorts) return;
    try {
      setStatus(await ports.invoke<AccessStatus>("remote_access_status"));
      setError(undefined);
    } catch {
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
    setSettingsOpen(false);
  }, []);
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
        value={{ settings, projectHost: selectedHost?.name }}
      >
        <Suspense fallback={fallback()}>
          {selectedHost ? (
            <Workspace key={selectedHost.id} host={selectedHost} />
          ) : (
            children
          )}
        </Suspense>
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
