// Development-only browser chrome preview; no native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserPreviewSurface } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

function Fixture() {
  const [active, setActive] = useState(true);
  const [narrow, setNarrow] = useState(false);
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
          onStopAgent={() => setActive(false)}
        />
      </div>
    </main>
  );
}
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<Fixture />);
