import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@gyro-dev/ui/styles.css";
import { GithubSidebarPanel } from "../../../packages/ui/src/workspace-sidebar";
import type {
  GithubAvailability,
  GithubSetupAction,
  GithubState,
  SourceControlState,
} from "@gyro-dev/ui";

// Simulated `gh` answers for each setup state; nothing here talks to GitHub.
const base: GithubAvailability = {
  schema: "gyro.github.v1",
  available: false,
  cliInstalled: true,
  authenticated: true,
};
const setupAvailability = {
  ...base,
  account: "octo-dev",
  host: "github.com",
  error: "no git remotes found",
};
const localRepository: SourceControlState = {
  provider: "git",
  available: true,
  readState: "ready",
  detailsLoaded: true,
  branch: "forecast",
  ahead: 0,
  behind: 0,
  additions: 0,
  deletions: 0,
  statsPartial: false,
  files: [],
  history: [],
};
const states: Array<[string, GithubAvailability, SourceControlState?]> = [
  [
    "Not installed",
    { ...base, cliInstalled: false, authenticated: false, error: "The GitHub CLI (gh) is not installed." },
  ],
  [
    "Not signed in",
    { ...base, authenticated: false, error: "You are not logged into any GitHub hosts." },
  ],
  [
    "Local commits",
    setupAvailability,
    {
      ...localRepository,
      history: [{
        hash: "abc1234",
        shortHash: "abc1234",
        subject: "Start weather app",
        author: "Fixture",
        relativeDate: "1 day ago",
        refs: "HEAD -> forecast",
      }],
    },
  ],
  [
    "No local commits",
    setupAvailability,
    localRepository,
  ],
  [
    "Connected",
    { ...base, available: true, account: "octo-dev", host: "github.com", repository: "octo-dev/weather-app", defaultBranch: "main" },
  ],
];

function Panel({ label, availability, sourceControl }: {
  label: string;
  availability: GithubAvailability;
  sourceControl?: SourceControlState;
}) {
  const [running, setRunning] = useState<GithubSetupAction>();
  const github: GithubState = {
    availability,
    loading: false,
    lastCheckedAt: "2026-11-18T10:00:00Z",
    pullRequests: availability.available
      ? [{ number: 12, title: "Add hourly forecast", state: "open", headRef: "forecast", baseRef: "main", url: "#", isDraft: false, checks: "success" }]
      : [],
    runs: availability.available
      ? [{ id: 1, number: 41, title: "Add hourly forecast", workflowName: "CI", state: "success", status: "completed", branch: "forecast", sha: "abc1234", event: "push", url: "#" }]
      : [],
  } as GithubState;
  return (
    <section style={{ width: 300 }}>
      <h2 style={{ font: "600 12px system-ui", color: "var(--gyro-faint)", margin: "0 0 6px" }}>{label}</h2>
      <div className="gyro-sidebar" style={{ background: "var(--gyro-sidebar)", border: "1px solid var(--gyro-border-soft)", borderRadius: 10, padding: "6px 0", minHeight: 210 }}>
        <div className="gyro-scm-panel">
          <div className="gyro-scm-github-section">
            <GithubSidebarPanel
              github={github}
              branch="forecast"
              sourceControl={sourceControl}
              onSetup={(action) => {
                setRunning(action);
                window.setTimeout(() => setRunning(undefined), 2500);
              }}
              setupRunning={running}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <main style={{ background: "var(--gyro-pane)", color: "var(--gyro-text)", minHeight: "100vh", padding: 24, display: "flex", flexWrap: "wrap", gap: 20 }}>
    {states.map(([label, availability, sourceControl]) => (
      <Panel key={label} label={label} availability={availability} sourceControl={sourceControl} />
    ))}
  </main>,
);
