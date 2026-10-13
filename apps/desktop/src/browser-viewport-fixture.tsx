// Actual Browser component with a labeled local responsive-app fixture.
import { useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserPreviewSurface,
  createInitialWorkbenchState,
  workbenchReducer,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

function Fixture() {
  const [width, setWidth] = useState(480);
  const [state, dispatch] = useReducer(workbenchReducer, undefined, () =>
    workbenchReducer(createInitialWorkbenchState(), {
      type: "browser-navigate",
      status: "ready",
      url: new URL("browser-viewport-page.html", location.href).href,
    }),
  );
  return (
    <main
      style={{
        padding: 24,
        minHeight: "100vh",
        background: "var(--gyro-pane)",
        color: "var(--gyro-text)",
        fontFamily: "system-ui",
      }}
    >
      <h1 style={{ fontSize: 18 }}>Desktop fit · actual Browser component</h1>
      <p>
        Local app fixture. Resize the panel or change its viewport in Browser
        options.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[320, 480, 960].map((size) => (
          <button
            key={size}
            onClick={() => setWidth(size)}
            aria-pressed={width === size}
          >
            {size}px panel
          </button>
        ))}
        <output data-testid="viewport-mode">
          Mode:{" "}
          {state.browserPreview.deviceOverride
            ? state.browserPreview.device
            : "Auto"}{" "}
          · Layout: {state.browserPreview.device}
        </output>
      </div>
      <div
        className="gyro-chat-companion"
        style={{
          width,
          maxWidth: "100%",
          height: 600,
          display: "grid",
          gridTemplateRows: "minmax(0,1fr)",
          border: "1px solid var(--gyro-border-soft)",
        }}
      >
        <BrowserPreviewSurface
          variant="chat"
          browserPreview={state.browserPreview}
          onDeviceChange={(device) =>
            dispatch({ type: "browser-device", device })
          }
        />
      </div>
    </main>
  );
}
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
