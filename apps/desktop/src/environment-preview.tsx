// Development-only preview of the production Environment popover.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatEnvironmentPopover, type SourceControlState } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const base: SourceControlState = {
  provider: "git",
  available: true,
  branch: "feature/environment",
  upstream: "origin/feature/environment",
  ahead: 0,
  behind: 0,
  additions: 335,
  deletions: 338,
  statsPartial: false,
  detailsLoaded: true,
  comparedToMain: { additions: 12487, deletions: 2390, partial: false },
  stashCount: 5,
  files: [
    {
      path: "src/environment.tsx",
      state: "modified",
      staged: false,
      additions: 335,
      deletions: 338,
    },
  ],
  history: [
    {
      hash: "abc123",
      shortHash: "abc123",
      subject: "Update Environment",
      author: "Fixture",
      relativeDate: "2 days ago",
      refs: "",
    },
  ],
};
const fixtures: Record<string, SourceControlState> = {
  // Exercises the sections a bare branch never shows: attachments, the branch
  // dropdown, and a stash count.
  "Rich context": { ...base, stashCount: 2 },
  "Branch total": base,
  "Large branch": {
    ...base,
    comparedToMain: { additions: 1234567, deletions: 765432, partial: false },
  },
  "Clean branch": {
    ...base,
    comparedToMain: { additions: 0, deletions: 0, partial: false },
  },
  "No main comparison": { ...base, comparedToMain: undefined },
  Loading: { ...base, detailsLoaded: false, comparedToMain: undefined },
  "Read failed": {
    ...base,
    statsPartial: true,
    comparedToMain: { additions: 4, deletions: 0, partial: true },
  },
  // Matches a published, clean checkout whose branch still differs from main:
  // the diff must read as "vs main", and the commit subject must stay readable.
  "Clean published": {
    ...base,
    branch: "v0.1.0",
    upstream: "origin/v0.1.0",
    ahead: 0,
    behind: 0,
    additions: 0,
    deletions: 0,
    files: [],
    stashCount: 5,
    comparedToMain: { additions: 300719, deletions: 16883, partial: false },
    history: [
      {
        hash: "def456",
        shortHash: "def456",
        subject: "Polish the environment popover",
        author: "Fixture",
        relativeDate: "10 hours ago",
        refs: "",
      },
    ],
  },
};
function Fixture() {
  const [fixture, setFixture] = useState("Branch total");
  const [open, setOpen] = useState(true);
  const [action, setAction] = useState("");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        aria-label="Fixture controls"
        style={{
          padding: 12,
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>Environment · production component fixture</strong>
        <label>
          Scenario{" "}
          <select
            value={fixture}
            onChange={(event) => {
              setFixture(event.target.value);
              setOpen(true);
            }}
          >
            {Object.keys(fixtures).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <button onClick={() => setOpen(true)}>Open Environment</button>
      </nav>
      <style>{`.environment-fixture, .environment-fixture * { animation: none !important; transition: none !important; } .environment-fixture .gyro-chat-environment-popover { position: relative; top: auto; right: auto; max-height: none; margin: 24px; width: min(320px, calc(100% - 48px)); }`}</style>
      <div
        className="gyro-chat-surface is-thread environment-fixture"
        style={{ position: "relative", flex: 1, display: "block" }}
      >
        <p style={{ margin: 24, color: "var(--gyro-muted)" }}>
          Fixture data · committed branch work plus current edits and untracked
          files.
        </p>
        <p role="status" style={{ margin: 24 }}>
          {action}
        </p>
        {open ? (
          <ChatEnvironmentPopover
            attachments={
              fixture === "Rich context"
                ? [
                    {
                      id: "a1",
                      kind: "image",
                      name: "screenshot.png",
                      path: "/fixture/screenshot.png",
                      size: 2048,
                    },
                    {
                      id: "a2",
                      kind: "workspace-file",
                      name: "surfaces.tsx",
                      path: "/fixture/surfaces.tsx",
                      size: 9120,
                    },
                    {
                      id: "a3",
                      kind: "terminal-output",
                      name: "test-output.txt",
                      path: "/fixture/test-output.txt",
                      size: 120,
                    },
                  ]
                : []
            }
            plan={
              fixture === "Rich context"
                ? {
                    title: "Environment popover",
                    items: [
                      {
                        id: "step-1",
                        title: "Rebuild the card",
                        status: "complete",
                        createdAt: "2026-10-18T10:00:00Z",
                        updatedAt: "2026-10-18T10:30:00Z",
                      },
                      {
                        id: "step-2",
                        title: "Restyle the branch dropdown",
                        status: "in-progress",
                        createdAt: "2026-10-18T10:00:00Z",
                        updatedAt: "2026-10-18T10:30:00Z",
                      },
                      {
                        id: "step-3",
                        title: "Verify every section",
                        status: "todo",
                        createdAt: "2026-10-18T10:00:00Z",
                        updatedAt: "2026-10-18T10:30:00Z",
                      },
                    ],
                  }
                : undefined
            }
            branchLabel={fixtures[fixture]?.branch ?? base.branch!}
            branchItems={[]}
            sourceControl={fixtures[fixture]}
            workspacePath="/fixture/Gyro"
            onClose={() => setOpen(false)}
            onOpenReview={(scope) =>
              setAction(`Fixture action: opened ${scope.kind} review`)
            }
            onOpenTab={(tab) => setAction(`Fixture action: opened ${tab}`)}
          />
        ) : null}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
