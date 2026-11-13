// Development-only UI fixture. Selection/IPC are simulated, not native evidence.
import React, { useEffect, useRef, useState } from "react";
import { prepareAnnotationCapture } from "./browser-annotations";
import { createRoot } from "react-dom/client";
import { BrowserPreviewSurface } from "@gyro-dev/ui";
import type {
  BrowserElementAnnotation,
  BrowserPreview,
  BrowserScreenshotHandler,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const annotation: BrowserElementAnnotation = {
  schema: "gyro.browser-annotation.v1",
  framing: "OBSERVED_PAGE_CONTENT_UNTRUSTED",
  documentEpoch: "fixture",
  revision: 0,
  resourceId: "fixture",
  navigationId: 1,
  url: "https://example.test",
  capturedAt: "2026-11-11T17:00:00Z",
  viewport: { width: 960, height: 640, scrollX: 0, scrollY: 0 },
  ref: "ref_fixture_1",
  tag: "article",
  role: "group",
  name: "Website redesign",
  text: "Website redesign",
  selector: "#start",
  shadowRoot: false,
  rect: { x: 64, y: 128, width: 320, height: 220 },
  outline: {
    path: "M24 0H296Q320 0 320 24V196Q320 220 296 220H24Q0 220 0 196V24Q0 0 24 0Z",
    matrix: [1, 0, 0, 1, 64, 128],
    exact: true,
  },
  styles: { display: "block" },
};
function Fixture() {
  const params = new URLSearchParams(location.search);
  const capture = params.has("capture");
  document.documentElement.dataset.theme = params.get("theme") || "dark";
  const selected = useRef(false);
  const active = useRef(false);
  const [added, setAdded] = useState("");
  const sendCount = useRef(0);
  const [sentImage, setSentImage] = useState("");
  const [fail, setFail] = useState(false);
  const [navigationId, setNavigationId] = useState(1);
  const error = useRef(false);
  error.current = fail;
  const handler: BrowserScreenshotHandler = async (action, feedback) => {
    if (action === "annotate-start") {
      active.current = true;
      selected.current = false;
      return { active: true };
    }
    if (action === "annotate-stop") {
      active.current = false;
      return {};
    }
    if (action === "annotate-read")
      return selected.current
        ? { annotation, active: false }
        : { active: active.current };
    if (action === "annotate-point")
      return error.current
        ? {
            error:
              "This capture is stale. Return to Live and select the element again.",
          }
        : { annotation };
    if (action === "annotate-capture") {
      if (error.current)
        return { error: "The page changed during capture. Select again." };
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 640;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return {
        capture: await prepareAnnotationCapture(
          annotation,
          canvas.toDataURL("image/png"),
          960,
          640,
        ),
      };
    }
    if (action === "annotate-send") {
      if (error.current)
        return { error: "Could not send. Your comment is preserved." };
      setAdded(feedback?.comment || "");
      setSentImage(feedback?.annotationCapture?.image || "");
      sendCount.current++;
      return { sent: true };
    }
    if (action === "annotate-add") {
      if (error.current)
        return { error: "This element is stale. Select it again in Live." };
      setAdded(feedback?.comment || "");
      return {};
    }
    if (action === "feedback") {
      setAdded(feedback?.comment || "");
      return true;
    }
    return undefined;
  };
  const src =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="#f5f5f3"/><text x="64" y="70" font-family="system-ui" font-size="28" fill="#222">Projects</text><text x="64" y="98" font-family="system-ui" font-size="14" fill="#666">A sample website for annotation testing</text><rect x="64" y="128" rx="24" width="320" height="220" fill="#fff" stroke="#d9d9d5"/><rect x="88" y="152" rx="10" width="48" height="48" fill="#e3eaff"/><text x="88" y="242" font-family="system-ui" font-size="22" fill="#222">Website redesign</text><text x="88" y="272" font-family="system-ui" font-size="14" fill="#666">Refresh the homepage and project cards.</text><text x="88" y="318" font-family="system-ui" font-size="13" fill="#666">In progress · 6 tasks</text><rect x="408" y="128" rx="24" width="320" height="220" fill="#fff" stroke="#d9d9d5"/><text x="432" y="242" font-family="system-ui" font-size="22" fill="#222">Mobile onboarding</text><text x="432" y="272" font-family="system-ui" font-size="14" fill="#666">Make the first session easier.</text></svg>',
    );
  useEffect(() => {
    const host = document.querySelector<HTMLElement>(
      ".gyro-browser-native-host",
    );
    if (host) {
      host.style.backgroundImage = `url("${src}")`;
      host.style.backgroundSize = "contain";
      host.style.backgroundRepeat = "no-repeat";
      host.style.backgroundPosition = "top center";
    }
  }, [src]);
  const preview: BrowserPreview = {
    url: annotation.url,
    history: [annotation.url],
    historyIndex: 0,
    device: "desktop",
    consoleErrors: 0,
    diagnostics: [],
    diagnosticsSupported: false,
    diagnosticsCaptured: false,
    captureStatus: capture ? "captured" : "idle",
    status: "ready",
    verificationMessage: "Fixture",
    nativeHost: true,
    nativeResourceId: "fixture",
    nativeNavigationId: navigationId,
    latestCapture: capture
      ? {
          path: "/fixture.png",
          filename: "fixture.png",
          width: 960,
          height: 640,
          createdAt: annotation.capturedAt,
          sourceUrl: annotation.url,
          src,
          annotationState: annotation,
        }
      : undefined,
  };
  return (
    <main
      style={{
        height: "100vh",
        background: "var(--gyro-pane)",
        color: "var(--gyro-text)",
      }}
    >
      <nav>
        <strong>Simulated selection · UI fixture</strong>
        <button
          onClick={() => {
            selected.current = true;
          }}
        >
          Fixture: choose target
        </button>
        <button onClick={() => setFail((value) => !value)}>
          Fixture: toggle stale
        </button>
        <button onClick={() => setNavigationId((value) => value + 1)}>
          Fixture: navigate
        </button>
        <output aria-label="Fixture draft" data-sends={sendCount.current}>
          {added}
        </output>
        {sentImage ? (
          <img
            src={sentImage}
            alt="Sent annotation crop"
            style={{ width: 120, verticalAlign: "top" }}
          />
        ) : null}
      </nav>
      <div
        className="gyro-chat-companion gyro-chat-companion-content"
        style={{ width: "100%", height: "calc(100vh - 64px)" }}
      >
        <BrowserPreviewSurface
          variant="chat"
          nativeHost
          browserPreview={preview}
          onScreenshot={handler}
          onHostBoundsChange={() => {}}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
