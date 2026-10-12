// Development-only preview of the production Environment popover.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatEnvironmentPopover, type SourceControlState } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const base: SourceControlState = {
  provider: "git", available: true, branch: "feature/environment",
  upstream: "origin/feature/environment", ahead: 0, behind: 0,
  additions: 335, deletions: 338, statsPartial: false, detailsLoaded: true,
  comparedToMain: { additions: 12487, deletions: 2390, partial: false },
  stashCount: 5,
  files: [{ path: "src/environment.tsx", state: "modified", staged: false, additions: 335, deletions: 338 }],
  history: [{ hash: "abc123", shortHash: "abc123", subject: "Update Environment", author: "Fixture", relativeDate: "2 days ago", refs: "" }],
};
const fixtures: Record<string, SourceControlState> = {
  "Branch total": base,
  "Large branch": { ...base, comparedToMain: { additions: 1234567, deletions: 765432, partial: false } },
  "Clean branch": { ...base, comparedToMain: { additions: 0, deletions: 0, partial: false } },
  "No main comparison": { ...base, comparedToMain: undefined },
  "Loading": { ...base, detailsLoaded: false, comparedToMain: undefined },
  "Read failed": { ...base, statsPartial: true, comparedToMain: { additions: 4, deletions: 0, partial: true } },
};
function Fixture() {
  const [fixture, setFixture] = useState("Branch total");
  const [open, setOpen] = useState(true);
  const [action, setAction] = useState("");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav aria-label="Fixture controls" style={{ padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>Environment · production component fixture</strong>
        <label>Scenario{" "}
          <select value={fixture} onChange={(event) => { setFixture(event.target.value); setOpen(true); }}>
            {Object.keys(fixtures).map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        <button onClick={() => setOpen(true)}>Open Environment</button>
      </nav>
      <style>{`.environment-fixture, .environment-fixture * { animation: none !important; transition: none !important; } .environment-fixture .gyro-chat-environment-popover { position: relative; top: auto; right: auto; max-height: none; margin: 24px; width: min(300px, calc(100% - 48px)); }`}</style>
      <div className="gyro-chat-surface is-thread environment-fixture" style={{ position: "relative", flex: 1, display: "block" }}>
        <p style={{ margin: 24, color: "var(--gyro-muted)" }}>Fixture data · committed branch work plus current edits and untracked files.</p>
        <p role="status" style={{ margin: 24 }}>{action}</p>
        {open ? (
          <ChatEnvironmentPopover
            attachments={[]}
            branchLabel={base.branch!}
            branchItems={[]}
            sourceControl={fixtures[fixture]}
            workspacePath="/fixture/Gyro"
            onClose={() => setOpen(false)}
            onOpenReview={(scope) => setAction(`Fixture action: opened ${scope.kind} review`)}
            onOpenTab={(tab) => setAction(`Fixture action: opened ${tab}`)}
          />
        ) : null}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
