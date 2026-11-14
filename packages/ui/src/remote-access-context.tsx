import { createContext, useContext, type ReactNode } from "react";
import { Monitor } from "lucide-react";

/** Native host integrations supply these slots; UI previews need no networking. */
export const RemoteAccessSlots = createContext<{
  navigation?: ReactNode;
  settings?: ReactNode;
  /** Present only while rendering projects from the selected remote host. */
  projectHost?: string;
}>({});
export function MachineNavigation() {
  return useContext(RemoteAccessSlots).navigation ?? null;
}
export function RemoteAccessSettingsContent() {
  return useContext(RemoteAccessSlots).settings ?? null;
}
export function useRemoteProjectHost() {
  return useContext(RemoteAccessSlots).projectHost;
}
export function RemoteProjectIndicator() {
  const host = useRemoteProjectHost();
  if (!host) return null;
  return (
    <small
      className="gyro-sidebar-project-remote"
      title={`Remote on ${host}`}
      aria-label={`Remote on ${host}`}
    >
      <Monitor aria-hidden="true" />
      Remote
    </small>
  );
}
