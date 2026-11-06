import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerEffortSelector } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "../../../packages/ui/src/appearance.css";

const labels = ["Low", "Medium", "High", "XHigh", "Maximum", "Ultra"];

function EffortDragPreview() {
  const [index, setIndex] = useState(1);
  const [commits, setCommits] = useState<number[]>([]);
  const [theme, setTheme] = useState("dark");
  const [zoomed, setZoomed] = useState(true);
  const [sample, setSample] = useState("No pointer sample");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main className="effort-preview">
      <style>{`
        body { margin: 0; background: var(--gyro-app); color: var(--gyro-text); }
        .effort-preview { max-width: 1100px; margin: auto; padding: 32px; font: 14px/1.5 system-ui; }
        .effort-preview h1 { font-size: 22px; }
        .effort-preview nav { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 24px; }
        .effort-preview nav button { padding: 6px 12px; border: 1px solid var(--gyro-border); border-radius: 6px; background: var(--gyro-control); color: inherit; }
        .effort-preview .gyro-chat-surface { display: block; min-height: 240px; padding-top: 140px; overflow: visible; }
        .effort-preview .gyro-composer-shell { overflow: visible; width: min(680px, 100%); margin-left: auto; padding: 16px; border: 1px solid var(--gyro-border); border-radius: 18px; background: var(--gyro-pane); }
        .effort-preview .gyro-composer-bar { display: flex; justify-content: flex-end; min-height: 28px; }
        .effort-preview output { display: block; margin-block: 16px; overflow-wrap: anywhere; }
      `}</style>
      <h1>Effort slider drag preview</h1>
      <p>
        Development fixture with the actual Gyro component and composer zoom. No
        live provider settings.
      </p>
      <nav>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          Toggle theme
        </button>
        <button onClick={() => setZoomed(!zoomed)}>
          Composer zoom: {zoomed ? "95%" : "100%"}
        </button>
        <button
          onClick={() => {
            setIndex(1);
            setCommits([]);
          }}
        >
          Reset to Medium
        </button>
      </nav>
      <section
        className="gyro-chat-surface"
        style={
          { "--gyro-composer-zoom": zoomed ? 0.95 : 1 } as React.CSSProperties
        }
      >
        <div className="gyro-composer-shell">
          <p>Drag the thumb in either direction, then release.</p>
          <div className="gyro-composer-bar">
            <div
              className="gyro-composer-control gyro-composer-control-effort"
              onPointerDownCapture={(event) => {
                const input = event.currentTarget.querySelector("input")!;
                const rect = input.getBoundingClientRect();
                const thumb = event.currentTarget
                  .querySelector(".gyro-effort-slider-thumb")!
                  .getBoundingClientRect();
                setSample(
                  JSON.stringify({
                    clientX: event.clientX,
                    rangeLeft: rect.left,
                    rangeWidth: rect.width,
                    thumbCenter: thumb.left + thumb.width / 2,
                  }),
                );
              }}
            >
              <button
                className="gyro-composer-chip gyro-effort-chip gyro-composer-effort-trigger"
                type="button"
                aria-expanded="true"
              >
                {labels[index]}
              </button>
              <ComposerEffortSelector
                id="effort-preview-selector"
                labels={labels}
                selectedIndex={index}
                placement="up"
                fastMode={{ enabled: false, onToggle: () => {} }}
                onSelect={(next) => {
                  setIndex(next);
                  setCommits((current) => [...current, next]);
                }}
              />
            </div>
          </div>
        </div>
      </section>
      <output aria-label="Saved effort choices">
        Saved choices: {commits.length}; selected: {labels[index]}
      </output>
      <output aria-label="Pointer geometry">{sample}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<EffortDragPreview />);
