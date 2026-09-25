// Development-only check of the terminal strip's pane list.
//
// A chat's model-owned terminal is a focus, not one of the terminals the user
// manages: it must stay out of the strip unless it is the pane being shown on
// purpose. Open with `pnpm desktop:dev` and
// http://127.0.0.1:1420/terminal-strip-fixture.html — "Select model terminal"
// is the explicit open (Focus → Open in workspace, or Follow).
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  TerminalPanel,
  terminalDefaultProfiles,
  type TerminalPane,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const basePane = {
  branch: "main",
  createdAt: "2026-09-25T08:00:00.000Z",
  lastEvent: "running",
  profileId: "shell",
  status: "running",
  workspaceMode: "local",
} as const;

const shellPane: TerminalPane = {
  ...basePane,
  id: "pane-shell",
  title: "zsh",
  command: "zsh",
  output: "$ pwd\n/Users/example/Project\n$",
};

const taskPane: TerminalPane = {
  ...basePane,
  id: "workspace-task-catalog%3Averify",
  title: "pnpm run catalog:verify",
  command: "pnpm run catalog:verify",
  output: "$ pnpm run catalog:verify\nverifying catalog\nchecks passed",
};

const modelPane: TerminalPane = {
  ...basePane,
  id: "model:fixture-session",
  title: "Model · pnpm",
  command: "pnpm check",
  output: "$ pnpm check\nrunning checks",
  owner: {
    kind: "model",
    sessionId: "fixture-session",
    turnId: "fixture-turn",
    callId: "fixture-call",
  },
};

const panes = [shellPane, taskPane, modelPane];
const profiles = terminalDefaultProfiles();

function Fixture() {
  const [selectedPaneId, setSelectedPaneId] = useState<string>(shellPane.id);
  const choices = [
    { id: shellPane.id, label: "Select shell" },
    { id: taskPane.id, label: "Select task terminal" },
    { id: modelPane.id, label: "Select model terminal" },
  ];
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        aria-label="Terminal selection"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 12 }}
      >
        {choices.map((choice) => (
          <button
            aria-pressed={selectedPaneId === choice.id}
            key={choice.id}
            onClick={() => setSelectedPaneId(choice.id)}
            type="button"
          >
            {choice.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalPanel
          activeProfileId="shell"
          onAddTerminalPane={() => {}}
          onCloseTerminalPane={() => {}}
          onMoveTerminalPane={() => {}}
          onOpenCommandPalette={() => {}}
          onProfileChange={() => {}}
          onRunProfile={() => {}}
          onSelectTerminalPane={setSelectedPaneId}
          onSplitTerminalPane={() => {}}
          onWriteTerminalInput={() => {}}
          output=""
          profiles={profiles}
          renderTerminalPaneBody={(pane) => (
            <pre style={{ margin: 0, padding: 12 }}>{pane.output}</pre>
          )}
          selectedTerminalPaneId={selectedPaneId}
          terminalPanes={panes}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
