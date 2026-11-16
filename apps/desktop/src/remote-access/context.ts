import { createContext, useContext, useEffect, useState } from "react";
import { readBoundedLocalStorage, readStoredAppearance } from "../ui-storage";
import type { AccessStatus, Peer } from "./types";
import type { NativePorts } from "./client";
import type { RemoteSelection } from "./catalog";
export type RemoteAccessContextValue = {
  ports: NativePorts;
  status?: AccessStatus;
  error?: string;
  selectedHost?: Peer;
  selectHost: (host?: Peer) => void;
  refresh: () => Promise<void>;
  action: <T = unknown>(request: Record<string, unknown>) => Promise<T>;
  openSettings: () => void;
  selectRemote: (selection: RemoteSelection) => void;
  refreshCatalog: () => Promise<void>;
  connectedHostIds: string[];
};
export const RemoteAccessContext =
  createContext<RemoteAccessContextValue | null>(null);
export function useRemoteAccess() {
  const value = useContext(RemoteAccessContext);
  if (!value) throw new Error("Remote access context is missing");
  return value;
}

/** Monaco and xterm paint their own surfaces, so CSS theme changes need a render. */
export function useRemoteTheme(): "light" | "dark" {
  const read = (): "light" | "dark" =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const systemChanged = () => {
      const mode =
        readStoredAppearance().theme ??
        readBoundedLocalStorage("gyro.theme", 16) ??
        "system";
      if ("__TAURI_INTERNALS__" in window && mode === "system")
        document.documentElement.dataset.theme = media.matches
          ? "dark"
          : "light";
    };
    media.addEventListener("change", systemChanged);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", systemChanged);
    };
  }, []);
  return theme;
}
