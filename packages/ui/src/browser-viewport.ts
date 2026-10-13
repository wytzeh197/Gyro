import type { BrowserHostBounds, BrowserPreviewDevice } from "./types.ts";

export function automaticBrowserDevice(value: string): BrowserPreviewDevice {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "responsive";
    const host = url.hostname.toLowerCase();
    return host === "localhost" ||
      /^127(?:\.\d{1,3}){3}$/.test(host) ||
      host === "[::1]"
      ? "desktop"
      : "responsive";
  } catch {
    return "responsive";
  }
}

export function browserViewportGeometry(
  device: BrowserPreviewDevice,
  host: Pick<BrowserHostBounds, "width" | "height">,
  viewport?: { width: number; height: number },
) {
  const preset = {
    desktop: [1280, 800],
    tablet: [768, 1024],
    mobile: [390, 844],
  } as const;
  const size =
    device === "responsive"
      ? [host.width, host.height]
      : viewport
        ? [viewport.width, viewport.height]
        : preset[device];
  const width = size[0],
    height = size[1];
  const scale = Math.min(host.width / width, host.height / height, 1);
  return { width, height, scale, left: (host.width - width * scale) / 2 };
}
