// Stills-only harness: renders one real Gyro surface per `view` for checking.
import { AbsoluteFill } from "remotion";
import { CliWorkspaceSurface, DiffReviewSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp, makeSessions } from "../app/GyroApp";
import { diffReview, files, terminalPanes } from "../app/fixtures";
import { config } from "../fixtures/config.js";
import { ide } from "../app/ide";

const noop = () => {};
const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }, { title: "Audit provider arguments" }]);

export const cli = (t: number, tab: "terminal" | "diff" = "terminal") => (
  <CliWorkspaceSurface
    files={files as never}
    profiles={config.commandProfiles as never}
    activeProfileId="claude"
    activePaneTab={tab}
    terminalPanes={terminalPanes(t) as never}
    selectedTerminalPaneId="t1"
    terminalTemplate={4}
    diffReview={diffReview() as never}
    terminalOutput=""
    onSelectFile={noop}
    onProfileChange={noop}
    onPaneTabChange={noop}
    onRunProfile={noop}
  />
);

export const review = () => (
  <DiffReviewSurface diffReview={diffReview() as never} workspacePath="/Users/demo/aurora" />
);

export const Probe: React.FC<{ view: string }> = ({ view }) => (
  <AbsoluteFill style={{ background: "#ECEEFB", alignItems: "center", justifyContent: "center" }}>
    <div style={{ transform: "scale(1.3)" }}>
      <GyroApp
        sessions={sessions}
        events={[]}
        className={view === "cli" ? "film-grid4" : ""}
        content={view === "cli" ? cli(20) : view === "review" ? review() : view === "ide" ? ide(20, [4, 9]) : undefined}
        chromeProps={view === "cli" ? { activeWorkspaceLayout: "terminal-grid" } : view === "ide" ? { activeWorkspaceLayout: "code", workspaceSidebarHidden: true } : {}}
      />
    </div>
  </AbsoluteFill>
);
