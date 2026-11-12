import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@gyro-dev/ui/styles.css";
import { WorkspacePreparationControl } from "../../../packages/ui/src/surfaces";
import { gitSetupMessage, reconcileGitPreparation } from "../../../packages/ui/src/workspace-preparation";
import type { WorkspacePreparationProgress } from "@gyro-dev/ui";

const base: WorkspacePreparationProgress = {
  runId: "fixture", workspacePath: "/fixture/project", phase: "tests",
  completedSteps: 5, totalSteps: 5, status: "ready", message: "Workspace ready",
  gitState: "ready", errors: [],
};
function Fixture() {
  const [progress, setProgress] = useState(base);
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const setScenario = (scenario: string) => {
    const errors: WorkspacePreparationProgress["errors"] = [];
    if (scenario === "timeout" || scenario === "mixed") {
      errors.push({ phase: "git", gitCheck: "status", message: "Couldn’t refresh Git status. Showing last-known changes." });
      errors.push({ phase: "git", gitCheck: "branches", message: "Couldn’t refresh Git branches." });
    }
    if (scenario === "mixed") errors.push({ phase: "watcher", message: "File watcher is unavailable." });
    setProgress({ ...base, errors, status: errors.length ? "degraded" : "ready",
      gitState: scenario === "no-repository" ? "not-repository" : scenario === "no-git" ? "unavailable" : errors.length ? "timed-out" : "ready" });
    setOpen(true);
  };
  const recover = (check: "status" | "branches") => setProgress((current) => reconcileGitPreparation(
    current, { workspacePath: base.workspacePath, runId: base.runId, check }, { available: true, readState: "ready" },
  )!);
  return <main style={{ color: "var(--gyro-text)", background: "var(--gyro-pane)", minHeight: "100vh", padding: "2rem" }}>
    <h1>Git readiness acceptance fixture</h1>
    <p>Production preparation component; simulated states, no GitHub account.</p>
    <nav aria-label="Fixture scenarios">
      {([["local", "Local Git"], ["no-repository", "No repository"], ["no-git", "Git unavailable"], ["timeout", "Git timeout"], ["mixed", "Git and watcher warnings"]] as const).map(([id, label]) =>
        <button key={id} type="button" onClick={() => setScenario(id)}>{label}</button>)}
    </nav>
    <p role="status" data-testid="source-control-message">{gitSetupMessage(progress.gitState) ?? (progress.errors.length ? "Git inspection needs attention." : "Local Git ready.")}</p>
    <button type="button" onClick={() => recover("status")}>Recover status only</button>
    <button type="button" onClick={() => recover("branches")}>Recover branches only</button>
    <div style={{ display: "flex", marginTop: "2rem", maxWidth: "36rem" }}>
      <WorkspacePreparationControl progress={progress} isOpen={open} onToggle={() => setOpen(!open)}
        onClose={() => setOpen(false)} controlRef={ref}
        onRetry={() => {
          setProgress((current) => ({ ...current, gitRetrying: true }));
          window.setTimeout(() => {
            recover("status");
            recover("branches");
            setProgress((current) => ({ ...current, gitRetrying: false }));
          }, 250);
        }} />
    </div>
    <output data-testid="state">{progress.status} · {progress.errors.length} warnings</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
