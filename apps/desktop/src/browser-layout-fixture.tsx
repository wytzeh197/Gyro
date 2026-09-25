// Development-only browser chrome preview; no native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserPreviewSurface } from "@gyro-dev/ui";
import type { BrowserFeedback, BrowserPreview } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

function Fixture() {
  const [active, setActive] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [captureVisible, setCaptureVisible] = useState(false);
  const [feedback, setFeedback] = useState<BrowserFeedback | null>(null);
  const mockImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#f4f6fa"/><rect x="48" y="44" width="864" height="552" rx="18" fill="white" stroke="#d7dce5"/><rect x="84" y="90" width="300" height="26" rx="6" fill="#c8d8ee"/><rect x="84" y="148" width="640" height="18" rx="4" fill="#e1e8f0"/><rect x="84" y="184" width="520" height="18" rx="4" fill="#e1e8f0"/><rect x="84" y="258" width="220" height="180" rx="12" fill="#a5c9e9"/><rect x="330" y="258" width="220" height="180" rx="12" fill="#d4bded"/><rect x="576" y="258" width="220" height="180" rx="12" fill="#a9dfc5"/><text x="84" y="520" font-family="sans-serif" font-size="24" fill="#384a63">Select a region to leave feedback</text></svg>')}`;
  const browserPreview: BrowserPreview | undefined = captureVisible
    ? {
        url: "https://example.test/current",
        history: ["https://example.test/current"],
        historyIndex: 0,
        device: "desktop",
        consoleErrors: 0,
        diagnostics: [],
        diagnosticsSupported: false,
        diagnosticsCaptured: false,
        captureStatus: "captured",
        latestCapture: {
          path: "/tmp/gyro-browser-fixture.png",
          filename: "gyro-browser-fixture.png",
          width: 960,
          height: 640,
          createdAt: "2026-09-25T12:00:00Z",
          sourceUrl: "https://example.test/captured",
          src: mockImage,
        },
        status: "ready",
        verificationMessage: "Ready",
      }
    : undefined;
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--gyro-pane)",
        color: "var(--gyro-text)",
      }}
    >
      <nav style={{ display: "flex", gap: 12, padding: 12 }}>
        <button
          onClick={() => {
            document.documentElement.dataset.theme =
              document.documentElement.dataset.theme === "light"
                ? "dark"
                : "light";
          }}
        >
          Toggle theme
        </button>
        <button onClick={() => setNarrow(!narrow)}>
          Toggle narrow browser
        </button>
        <button onClick={() => setActive(!active)}>Toggle activity</button>
        <button onClick={() => setCaptureVisible(!captureVisible)}>
          Toggle capture
        </button>
        {feedback ? (
          <span data-testid="feedback-result">Feedback added</span>
        ) : null}
      </nav>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: narrow ? 440 : "100%",
          maxWidth: 720,
          marginLeft: "auto",
          borderLeft: "1px solid var(--gyro-border-soft)",
        }}
      >
        <BrowserPreviewSurface
          variant="chat"
          agentActivity={active ? "Read the current page" : undefined}
          browserPreview={browserPreview}
          onScreenshot={(action, note) => {
            if (action === "feedback" && note) setFeedback(note);
          }}
          onStopAgent={() => setActive(false)}
        />
      </div>
    </main>
  );
}
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<Fixture />);
