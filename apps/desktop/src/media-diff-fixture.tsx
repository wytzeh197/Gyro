// Development-only regression fixture; no native commands or model calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, ScmReviewToolbar } from "@gyro-dev/ui";
import { DiffEditor, remeasureMonacoFonts } from "./monaco-editor";
import "@gyro-dev/ui/styles.css";

function Fixture() {
  const [received, setReceived] = useState<string[]>([]);
  const [result, setResult] = useState("Not checked");
  const [oldLayout, setOldLayout] = useState(false);
  const drop = (itemsOnly: boolean) => {
    const file = new File(["fixture"], "drop.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: itemsOnly
        ? { files: [], items: transfer.items, types: transfer.types }
        : transfer,
    });
    document.querySelector("textarea")!.dispatchEvent(event);
  };
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ display: "flex", gap: 12, padding: 12 }}>
        <button onClick={() => drop(false)}>Drop FileList image</button>
        <button onClick={() => drop(true)}>Drop file-item image</button>
        <button onClick={() => setOldLayout(!oldLayout)}>
          Toggle old layout
        </button>
        <button
          onClick={() => {
            const pane = document.querySelector(
              ".gyro-source-control-review-editor",
            )!;
            const height = pane.getBoundingClientRect().height;
            const lines = Array.from(
              pane.querySelectorAll(".view-lines"),
              (node) => node.textContent,
            ).join(" ");
            setResult(
              `${height > 150 && lines.includes("imageDrop") ? "PASS" : "FAIL"}: editor height ${Math.round(height)}px; source ${lines.includes("imageDrop") ? "rendered" : "missing"}`,
            );
          }}
        >
          Check diff layout
        </button>
      </nav>
      <output>
        Received {received.length} images: {received.join(", ")}. {result}
      </output>
      {oldLayout && (
        <style>{`.gyro-source-control-review {display:grid;grid-template-rows:auto auto minmax(0,1fr)} .gyro-source-control-review-editor{height:100%}`}</style>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "minmax(0, 1fr)",
          flex: 1,
          minHeight: 0,
        }}
      >
        <ChatSurface
          events={[]}
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          onSend={() => {}}
          onAttachMediaFiles={(files) =>
            setReceived((current) => [
              ...current,
              ...files.map((file) => file.name),
            ])
          }
          shellReady
        />
        <div className="gyro-source-control-review">
          <ScmReviewToolbar
            staged={false}
            summary="Fixture diff"
            canNavigate={false}
            onPrevious={() => {}}
            onNext={() => {}}
            onRefresh={() => {}}
            onOpenFile={() => {}}
          />
          <div className="gyro-source-control-review-editor">
            <DiffEditor
              original=""
              modified={'export const imageDrop = "ready";\n'}
              language="typescript"
              theme="gyro-light"
              onMount={() => requestAnimationFrame(remeasureMonacoFonts)}
              options={{
                automaticLayout: true,
                readOnly: true,
                minimap: { enabled: false },
              }}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
