import { useCurrentFrame } from "remotion";
import { DiffReviewSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp, makeSessions } from "../app/GyroApp";
import { diffReview } from "../app/fixtures";
import { cli } from "../scenes/Probe";
import { Camera } from "../ui/motion";
import { Stage, Window } from "../ui/film";
import { Marquee, Pop, Slab, INK, WHITE } from "../ui/bold";
import { C } from "../ui/theme";

const sessions = makeSessions([{ title: "Fix the checkout bug" }, { title: "Fix flaky editor file tests" }, { title: "Audit provider arguments" }]);

// 12–17s. Every CLI agent in one terminal grid.
export const CLI = 150;
export const Cli: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Stage color="ink">
      <Marquee text="CLAUDE CODE · CODEX · GEMINI ·" y={-30} size={300} speed={9} outline color="rgba(125,144,255,0.45)" />
      <Marquee text="CLAUDE CODE · CODEX · GEMINI ·" y={790} size={300} speed={-9} start={-2000} color="rgba(125,144,255,0.18)" />
      <Camera keys={[[0, 1060, 420, 1.5], [60, 1260, 420, 1.5], [96, 1060, 660, 1.5], [128, 960, 540, 1.02], [CLI, 960, 540, 1.04]]}>
        <Window shadow={C.blue}>
          <GyroApp
            sessions={sessions}
            events={[]}
            className="film-grid4"
            elapsedMs={f * 400}
            content={cli(1 + f / 7)}
            chromeProps={{ activeWorkspaceLayout: "terminal-grid" }}
          />
        </Window>
      </Camera>
      <Pop at={26} x={1620} y={150} rot={-5} bg={C.coral} fg={WHITE} monoFont>&gt; claude</Pop>
      <Pop at={36} x={1700} y={250} rot={4} bg={WHITE} fg={INK} monoFont>&gt; codex</Pop>
      <Pop at={46} x={1600} y={350} rot={-3} bg={C.blue} fg={WHITE} monoFont>&gt; gemini</Pop>
      <Slab at={8} lines={[{ t: "Every CLI agent.", bg: WHITE, fg: INK }, { t: "One terminal grid.", bg: C.blue, fg: WHITE }]} />
    </Stage>
  );
};

// 17–21s. Review the diff, then commit, push and open the PR without leaving.
export const REVIEW = 120;
export const Review: React.FC = () => {
  const f = useCurrentFrame();
  const approved = f >= 46;
  const pr = f >= 82;
  return (
    <Stage color="coral">
      <Marquee text="REVIEW · COMMIT · SHIP ·" y={-30} size={300} speed={8} color="rgba(255,255,255,0.2)" />
      <Marquee text="REVIEW · COMMIT · SHIP ·" y={790} size={300} speed={-8} start={-1800} outline color="rgba(255,255,255,0.35)" />
      <Camera keys={[[0, 960, 560, 1.06], [40, 960, 540, 1], [52, 1240, 300, 1.45], [104, 1240, 300, 1.45], [REVIEW, 1180, 340, 1.4]]}>
        <Window>
          <GyroApp
            sessions={sessions}
            events={[]}
            content={<DiffReviewSurface diffReview={diffReview("src/cart/total.ts", approved ? "approved" : "pending", pr) as never} workspacePath="/Users/demo/aurora" />}
          />
        </Window>
      </Camera>
      <Pop at={46} x={420} y={200} rot={-6} bg={C.green} fg={WHITE} size={56}>✓ Approved</Pop>
      <Pop at={82} x={560} y={330} rot={4} bg={WHITE} fg={INK} size={56}>PR #214 ↗</Pop>
      <Slab at={8} lines={[{ t: "Review the diff.", bg: INK, fg: WHITE }, { t: "Ship the PR.", bg: WHITE, fg: C.coral }]} />
    </Stage>
  );
};
