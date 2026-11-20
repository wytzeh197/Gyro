import { useSyncExternalStore } from "react";
import { Laptop, Monitor, Smartphone, type LucideProps } from "lucide-react";

export type DeviceKind = "laptop" | "desktop" | "phone";

export const DEVICE_KIND_OPTIONS: Array<{ label: string; value: DeviceKind }> =
  [
    { label: "Laptop", value: "laptop" },
    { label: "Desktop", value: "desktop" },
  ];

const STORAGE_KEY = "gyro.remote.deviceIcons";
const listeners = new Set<() => void>();
let cache: Record<string, DeviceKind> | undefined;

function read(): Record<string, DeviceKind> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache!;
}

/**
 * Names like "iPhone" read as phones and "MacBook Pro" as laptops; Mac mini,
 * iMac and Studio as desktops. The Mac picker only offers laptop and desktop.
 */
export function inferDeviceKind(name?: string): DeviceKind {
  if (name && /iphone|phone|android|pixel/i.test(name)) return "phone";
  return name && /macbook|laptop|notebook/i.test(name) ? "laptop" : "desktop";
}

export function deviceKind(
  id: string | null | undefined,
  name?: string,
): DeviceKind {
  return (id && read()[id]) || inferDeviceKind(name);
}

export function setDeviceKind(id: string, kind: DeviceKind) {
  cache = { ...read(), [id]: kind };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // The choice still applies for this window.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDeviceKind(id: string | null | undefined, name?: string) {
  return useSyncExternalStore(
    subscribe,
    () => deviceKind(id, name),
    () => inferDeviceKind(name),
  );
}

export function DeviceIcon({
  kind,
  ...props
}: { kind: DeviceKind } & LucideProps) {
  const Icon =
    kind === "phone" ? Smartphone : kind === "laptop" ? Laptop : Monitor;
  return <Icon data-device-kind={kind} {...props} />;
}
