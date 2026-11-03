import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserPreview } from "./types";
import { browserViewportGeometry } from "./browser-viewport";
import "./browser-preview-surround.css";

// Room reserved under a framed page for the stage label.
const LABEL_ROOM = 26;

/** Presentation only: the child remains a web viewport, never a native app. */
export function BrowserPreviewSurround({
  preview, disabled, children,
}: { preview: BrowserPreview; disabled: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHost({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const framed = !disabled && preview.device !== "responsive";
  const mobile = preview.device === "mobile";
  const tablet = preview.device === "tablet";
  const isDevice = mobile || tablet;
  // A desktop fit is the page itself, flush beneath the toolbar like any browser
  // tab. Only device presets keep a bezel, and only they need a gutter around it.
  const gutter = isDevice ? 12 : 0;
  const bezel = isDevice ? 10 : 0;
  const chrome = isDevice ? 16 : 0;
  const viewport = browserViewportGeometry(preview.device, host, preview.viewport);
  const outerWidth = viewport.width + bezel * 2;
  const outerHeight = viewport.height + bezel * 2 + chrome;
  const scale = Math.max(
    0,
    Math.min(
      (host.width - gutter * 2) / outerWidth,
      (host.height - gutter - LABEL_ROOM) / outerHeight,
      1,
    ),
  );
  const zoom = scale < 1 ? ` · ${Math.round(scale * 100)}%` : "";
  return (
    <div
      ref={ref}
      className="gyro-preview-stage"
      data-framed={framed}
      style={framed ? { paddingTop: gutter } : undefined}
    >
      <div
        className="gyro-preview-surround"
        data-kind={mobile ? "phone" : tablet ? "tablet" : "browser"}
        style={framed ? {
          width: outerWidth * scale,
          height: outerHeight * scale,
          padding: bezel * scale,
          paddingTop: (bezel + chrome) * scale,
          // The native page cannot be clipped, so the outer radius has to stay
          // small enough that the square screen never crosses the bezel's curve.
          borderRadius: (mobile ? 24 : tablet ? 18 : 0) * scale,
        } : undefined}
      >
        {framed && isDevice && (
          <div className="gyro-preview-surround-caption" style={{ height: chrome * scale, top: bezel * scale }}>
            <span className="gyro-preview-device-speaker" aria-hidden="true" />
          </div>
        )}
        {children}
      </div>
      {framed && (
        <span className="gyro-preview-stage-label">
          Web preview · {mobile ? "Phone" : tablet ? "Tablet" : "Desktop"} · {viewport.width} × {viewport.height}{zoom}
        </span>
      )}
    </div>
  );
}
