// Read the diff, approve, the commit goes green, and the green wipes into night.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DiffReviewSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp } from "../app/GyroApp";
import { diffReview } from "../app/fixtures";
import { W, sessions } from "../cut/data";
import { C } from "../ui/theme";
import { Key, Stripes, TakeCam, TakePointer, TypeCard, camAt, p01 } from "./kit";

export const REVIEW = 250;
const AX = 320;
const AY = 140;
const at = (x: number, y: number): [number, number] => [AX + x, AY + y];
const lines = at(880, 260);
const commit = at(860, 740);
const approve = at(758, 769);
const CLICK = 132;
const LINE = 150;
const WIPE: [number, number] = [214, 250];

const keys: Key[] = [
  [0, 960, 540, 1.0],
  [20, 960, 540, 1.0],
  [52, lines[0], lines[1], 1.55],
  [84, lines[0], lines[1], 1.55],
  [110, commit[0], commit[1] - 60, 1.6],
  [142, commit[0], commit[1] - 60, 1.6],
  [170, 960, 560, 0.92],
];

export const Review: React.FC = () => {
  const f = useCurrentFrame();
  const cam = camAt(keys, f);
  const ok = f >= CLICK + 2;
  const appIn = p01(f, 0, 14);
  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <TakeCam cam={cam}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, background: C.canvas, opacity: appIn }} />
        <div style={{ position: "absolute", left: AX, top: AY, opacity: appIn, boxShadow: "0 0 0 1px rgba(16,20,42,0.08), 0 30px 80px -24px rgba(16,20,42,0.35)", borderRadius: 14 }}>
          <GyroApp sessions={sessions} events={[]} content={<DiffReviewSurface diffReview={diffReview("src/cart/total.ts", ok ? "approved" : "pending") as never} workspacePath={W} />} />
        </div>
      </TakeCam>
      <TakePointer cam={cam} keys={[[96, approve[0] + 260, approve[1] - 160], [CLICK - 4, approve[0], approve[1]]]} clicks={[CLICK]} at={96} until={CLICK + 24} />
      <TypeCard text="Review every change." at={LINE} cps={0.45} until={WIPE[1]} size={56} y={78} />
      <Stripes p={p01(f, WIPE[0], WIPE[1])} />
    </AbsoluteFill>
  );
};
