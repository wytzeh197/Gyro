import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BrowserPreview } from "./types";
import { browserViewportGeometry } from "./browser-viewport";
import "./browser-preview-surround.css";

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
  const bezel = mobile || tablet ? 10 : 1;
  const chrome = mobile || tablet ? 16 : 32;
  const viewport = browserViewportGeometry(preview.device, host, preview.viewport);
  const outerWidth = viewport.width + bezel * 2;
  const outerHeight = viewport.height + bezel * 2 + chrome;
  const scale = Math.max(0, Math.min((host.width - 24) / outerWidth, (host.height - 24) / outerHeight, 1));
  return (
    <div ref={ref} className="gyro-preview-stage" data-framed={framed}>
      <div
        className="gyro-preview-surround"
        data-kind={mobile ? "phone" : tablet ? "tablet" : "browser"}
        style={framed ? {
          width: outerWidth * scale,
          height: outerHeight * scale,
          padding: bezel * scale,
          paddingTop: (bezel + chrome) * scale,
          borderRadius: (mobile ? 36 : tablet ? 24 : 10) * scale,
        } : undefined}
      >
        {framed && (
          <div className="gyro-preview-surround-caption" style={{ height: chrome * scale, top: bezel * scale, fontSize: Math.max(9, 12 * scale) }}>
            {mobile || tablet ? <span className="gyro-preview-device-speaker" aria-hidden="true" /> : <span>Web preview</span>}
          </div>
        )}
        {children}
      </div>
      {framed && <span className="gyro-preview-stage-label">{mobile ? "Phone" : tablet ? "Tablet" : "Desktop"} · Web preview</span>}
    </div>
  );
}
