// Standalone fixture of the actual artifact card. Actions are simulated.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatArtifacts, type ChatArtifact } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
const previewUrl = "http://127.0.0.1:1420/token-usage-fixture.html?theme=dark&case=large";
function Fixture() {
  const [action, setAction] = useState("");
  const [status, setStatus] = useState("ready");
  const [longTitle, setLongTitle] = useState(false);
  const artifact: ChatArtifact = {
    id: "token-accounting-preview",
    kind: "preview",
    title: longTitle ? "Token accounting verification with a deliberately long title" : "Token accounting verification",
    url: previewUrl,
    description: "Actual chat components with labeled synthetic usage fixtures.",
    ...(status === "ready" ? {} : { status: status as "streaming" | "failed" | "stale" }),
  };
  return <main className="preview-artifact-fixture">
    <style>{`
      html, body, #root { min-height:100%; margin:0; background:var(--gyro-app); color:var(--gyro-text); }
      .preview-artifact-fixture { max-width:500px; margin:40px auto; padding:0 12px; font-family:var(--gyro-font-ui); }
      .preview-artifact-fixture h1 { font-size:14px; font-weight:500; margin:0 12px 8px; }
      .preview-artifact-fixture > p { color:var(--gyro-muted); font-size:11px; margin:0 12px 24px; }
      .preview-artifact-capture { padding:12px; background:var(--gyro-app); }
      .preview-artifact-capture .gyro-chat-artifacts { margin:0; }
      .preview-artifact-fixture nav { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin:24px 12px 12px; color:var(--gyro-muted); font-size:11px; }
      .preview-artifact-fixture label { display:flex; gap:6px; align-items:center; }
      .preview-artifact-fixture output { display:block; margin:12px; color:var(--gyro-muted); font-size:11px; overflow-wrap:anywhere; }
    `}</style>
    <h1>Compact preview card</h1>
    <p>Actual component · fixture actions are simulated</p>
    <div className="preview-artifact-capture">
      <ChatArtifacts artifacts={[artifact]} actions={{
        onOpenPreview: url => setAction(`Panel opened: ${url}`),
        onOpenExternalPreview: url => setAction(`External opened: ${url}`),
      }} />
    </div>
    <nav aria-label="Preview fixture controls">
      <label>State <select aria-label="Preview state" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="ready">Ready</option><option value="streaming">Loading</option>
        <option value="failed">Failed</option><option value="stale">Stale</option>
      </select></label>
      <label><input aria-label="Long preview title" type="checkbox" checked={longTitle} onChange={event => setLongTitle(event.target.checked)} />Long title</label>
    </nav>
    <output aria-live="polite">{action || "Use either open action to verify it."}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
