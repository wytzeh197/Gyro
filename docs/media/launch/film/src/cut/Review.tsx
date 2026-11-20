// 19–23s. Crop on the added lines, circle them, pull back, mark reviewed.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DiffReviewSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp } from "../app/GyroApp";
import { diffReview } from "../app/fixtures";
import { Camera } from "../ui/motion";
import { AppStage, Canvas, HandCircle, Pointer, WordBuild } from "../ui/skale";
import { W, sessions } from "./data";

export const REVIEW = 120;
const CLICK = 84;

export const Review: React.FC = () => {
  const f = useCurrentFrame();
  const status = f >= CLICK + 2 ? "approved" : "pending";
  return (
    <AbsoluteFill>
      <Canvas />
      <Camera keys={[[0, 1307, 401, 2.0], [40, 1307, 401, 2.0], [70, 1350, 300, 1.4], [REVIEW, 1330, 320, 1.36]]}>
        <AppStage>
          <GyroApp sessions={sessions} events={[]} content={<DiffReviewSurface diffReview={diffReview("src/cart/total.ts", status) as never} workspacePath={W} />} />
        </AppStage>
        <HandCircle x={1307 - 260} y={401 - 70} w={520} h={140} at={18} until={70} />
        <Pointer keys={[[56, 1700, 340], [CLICK - 4, 1523, 146]]} clicks={[CLICK]} at={56} until={REVIEW} />
      </Camera>
      <WordBuild words={["Review", "every", "change."]} at={92} size={84} y={960} />
    </AbsoluteFill>
  );
};
