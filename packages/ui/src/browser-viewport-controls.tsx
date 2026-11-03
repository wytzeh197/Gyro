import { useLayoutEffect, useRef, useState } from "react";
import { Monitor, Smartphone, Tablet, ScanLine } from "lucide-react";
import { browserViewportGeometry } from "./browser-viewport.ts";
import type { BrowserPreview, BrowserViewportMode } from "./types.ts";

export function BrowserViewportControls({
  preview,
  onChange,
}: {
  preview: BrowserPreview;
  onChange?: (mode: BrowserViewportMode) => void;
}) {
  const mode =
    preview.viewport?.mode ??
    (preview.deviceOverride ? preview.device : "auto");
  return (
    <div
      className="gyro-browser-device-group"
      role="group"
      aria-label="Browser viewport"
    >
      <button
        type="button"
        aria-label="Automatic viewport"
        aria-pressed={mode === "auto"}
        className={mode === "auto" ? "is-text is-active" : "is-text"}
        title="Automatic: Desktop fit for local previews, Responsive for websites"
        onClick={() => onChange?.("auto")}
      >
        Auto
      </button>
      {(
        [
          { id: "responsive", label: "Responsive", Icon: ScanLine, size: 14 },
          { id: "desktop", label: "Desktop fit", Icon: Monitor, size: 14 },
          // Both are portrait outlines; the size difference tells them apart.
          { id: "tablet", label: "Tablet", Icon: Tablet, size: 15 },
          { id: "mobile", label: "Mobile", Icon: Smartphone, size: 13 },
        ] as const
      ).map(({ id, label, Icon, size }) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          aria-pressed={mode === id}
          className={mode === id ? "is-active" : undefined}
          title={label}
          onClick={() => onChange?.(id)}
        >
          <Icon size={size} />
        </button>
      ))}
    </div>
  );
}

// Standalone component previews use the same geometry as the native Browser.
// CSS transforms preserve iframe layout width, page state and DOM coordinates.
export function FittedBrowserFrame({
  preview,
  url,
}: {
  preview: BrowserPreview;
  url: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setHost({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const geometry = browserViewportGeometry(
    preview.device,
    host,
    preview.viewport,
  );
  return (
    <div ref={ref} className="gyro-browser-fitted-frame">
      {host.width > 0 && host.height > 0 ? (
        <iframe
          referrerPolicy="no-referrer"
          src={url}
          title="Browser preview"
          style={{
            position: "absolute",
            top: 0,
            left: geometry.left,
            width: geometry.width,
            height: geometry.height,
            minHeight: 0,
            transform: `scale(${geometry.scale})`,
            transformOrigin: "top left",
          }}
        />
      ) : null}
    </div>
  );
}
