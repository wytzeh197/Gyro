// Studio-only: the real app at 1:1 in the top-left corner, for measuring layout.
import { AbsoluteFill } from "remotion";
import { AutomationsSurface, DiffReviewSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp, makeSessions } from "../app/GyroApp";
import { diffReview } from "../app/fixtures";
import { cli } from "./Probe";
import { automations, userMsg, steps, approval } from "../cut/data";
const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }]);
export const Measure: React.FC<{ view?: string }> = ({ view = "chat" }) => (
  <AbsoluteFill style={{ background: "#fff" }}>
    <GyroApp
      sessions={sessions}
      events={(view === "approval" ? [userMsg, ...steps, approval("pending")] : []) as never}
      draft={view === "approval" ? "" : "Fix the checkout bug and open a PR."}
      className={view === "cli" ? "film-grid4" : ""}
      chromeProps={view === "cli" ? { activeWorkspaceLayout: "terminal-grid" } : view === "auto" ? { activeDestination: "automations" } : {}}
      content={
        view === "cli" ? cli(20) : view === "review" ? <DiffReviewSurface diffReview={diffReview("src/cart/total.ts", "pending", false) as never} workspacePath="/Users/demo/aurora" /> : view === "auto" ? <AutomationsSurface automations={automations(200) as never} selectedAutomationId="nightly-deps" /> : undefined
      }
    />
  </AbsoluteFill>
);
