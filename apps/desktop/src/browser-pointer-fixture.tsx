// Development-only page: exercise the same feedback factory injected by Tauri.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import source from "../src-tauri/src/browser_pointer_feedback.js?raw";

const feedback = new Function(
  `return (\n${source.trim().replace(/;$/, "")}\n);`,
)()(window, document);
function Fixture() {
  const [count, setCount] = useState(0);
  return (
    <main
      style={{
        fontFamily: "system-ui",
        padding: 32,
        color: "#252525",
        background: "#fff",
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <small>Development fixture</small>
      <h1 style={{ fontSize: 24, margin: "16px 0" }}>Browser pointer check</h1>
      <p>The blue pointer moves between targets in at most 140ms. Click feedback appears immediately; fixture actions do not wait for animation.</p>
      <button
        id="pointer-target"
        style={{ padding: "10px 16px", font: "inherit" }}
        onClick={() => setCount((value) => value + 1)}
      >
        Change visible state
      </button>
      <p aria-live="polite">Clicked {count} times</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 32 }}>
        <button
          onClick={() => {
            const target = document.getElementById("pointer-target")!;
            feedback.show(target, {
              action: "click",
              phase: "move",
              actor: "Gyro",
            });
            target.click();
            feedback.show(target, { action: "click", actor: "Gyro" });
          }}
        >
          Demo AI click
        </button>
        <button onClick={() => feedback.clear()}>Clear pointer</button>
        <button onClick={() => feedback.setHidden(true)}>
          Hide for capture
        </button>
        <button onClick={() => feedback.setHidden(false)}>
          Restore pointer
        </button>
      </div>
      <p>Alternate targets quickly to interrupt movement. Reduced motion follows your system preference.</p>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginTop: 48 }}>
        {["Left target", "Right target"].map((name) => (
          <button
            key={name}
            style={{ padding: 24, font: "inherit" }}
            onClick={(event) => feedback.show(event.currentTarget, { action: "hover", actor: "Gyro" })}
          >
            {name}
          </button>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
