// Development-only preview of the real sidebar with illustrative commit data.
import React from "react";
import { createRoot } from "react-dom/client";
import { AppChrome, createInitialWorkbenchState } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  query.get("theme") === "light" ? "light" : "dark";
const history = [
  {
    hash: "a10c8e1",
    subject: "Merge pull request #76 from release/0.1.0",
    parents: ["b20d9f2", "c30ea03"],
    refs: "HEAD -> main, origin/main",
  },
  {
    hash: "c30ea03",
    subject: "Prepare release and refresh the workspace",
    parents: ["d40fb14"],
    refs: "release/0.1.0",
  },
  {
    hash: "d40fb14",
    subject: "Polish source control graph and commit details",
    parents: ["b20d9f2"],
    refs: "",
  },
  {
    hash: "b20d9f2",
    subject: "Merge branch feature/editor into main",
    parents: ["e510c25", "f621d36"],
    refs: "tag: v0.1.0-alpha.49.6",
  },
  {
    hash: "f621d36",
    subject: "Keep editor selections when switching files",
    parents: ["a732e47"],
    refs: "feature/editor",
  },
  {
    hash: "e510c25",
    subject: "Refresh download site visuals",
    parents: ["a732e47"],
    refs: "",
  },
  {
    hash: "a732e47",
    subject: "Improve provider reliability",
    parents: ["b843f58"],
    refs: "",
  },
  { hash: "b843f58", subject: "Add workspace history", parents: [], refs: "" },
].map((commit, index) => ({
  ...commit,
  shortHash: commit.hash,
  hash: commit.hash.padEnd(40, "0"),
  parents: commit.parents.map((hash) => hash.padEnd(40, "0")),
  author: index % 2 ? "Wytze" : "Wytze Hemr",
  relativeDate: index === 0 ? "2 hours ago" : `${index + 2} hours ago`,
}));
const ide = createInitialWorkbenchState().ide;
ide.activeView = "source-control";
ide.sourceControl = {
  ...ide.sourceControl,
  available: true,
  branch: "main",
  upstream: "origin/main",
  history,
};
const noop = () => undefined;

createRoot(document.getElementById("root")!).render(
  <AppChrome
    activeDestination="workspace"
    activeWorkspaceLayout="code"
    workspacePath="/workspace/Gyro"
    workspaceSidebarWidth={320}
    ide={ide}
    sessions={[]}
    savedProjects={[]}
    commandProfiles={[]}
    onCreateCliSession={noop}
    onCreateSession={noop}
    onOpenCommandPalette={noop}
    onOpenSettings={noop}
    onOpenToolPanel={noop}
    onOpenWorkspace={noop}
    onSelectDestination={noop}
    onSelectSession={noop}
    onSelectSessions={noop}
    onSelectWorkspaceLayout={noop}
  >
    <div style={{ padding: 28, color: "var(--gyro-muted)" }}>
      <strong style={{ color: "var(--gyro-text)" }}>
        Commit graph preview
      </strong>
      <p>Hover a commit or focus a row to see its details.</p>
      <p>
        Illustrative history · <a href="?theme=light">Light</a> /{" "}
        <a href="?theme=dark">Dark</a>
      </p>
    </div>
  </AppChrome>,
);
