// 41–50s. Tiles assemble, a rotator recaps, then the cursor becomes the mark.
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Tiles } from "../ui/film";
import { GyroMark } from "../ui/parts";
import { Whip, clamp } from "../ui/motion";
import { Block, Brackets, Canvas, Decode, Rotator, blurIn, ease, line } from "../ui/skale";
import { C } from "../ui/theme";

export const CLOSE = 270;
const g = 16;
// A 2 × 2 grid of panes plus a sidebar, the shape of a Gyro window.
const rects = [
  { x: 240, y: 180, w: 280, h: 720, color: C.ink },
  { x: 520 + g, y: 180, w: 572, h: 352, color: C.blue },
  { x: 1108 + g, y: 180, w: 572, h: 352, color: "#C9D1FA" },
  { x: 520 + g, y: 548, w: 572, h: 352, color: "#C9D1FA" },
  { x: 1108 + g, y: 548, w: 572, h: 352, color: C.blue },
];

const Assemble: React.FC = () => (
  <Whip frames={70} exit="left" len={10}>
    <Canvas />
    <Tiles at={4} ox={948} oy={516} rects={rects} stagger={6} len={22} radius={18} />
  </Whip>
);

export const Close: React.FC = () => {
  const f = useCurrentFrame();
  if (f < 70) return <Assemble />;
  const recapOut = interpolate(f, [136, 146], [1, 0], clamp);
  const markIn = interpolate(f, [158, 172], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill>
      <Canvas color={C.ink} />
      {f < 148 && (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: recapOut, filter: recapOut < 1 ? `blur(${(1 - recapOut) * 12}px)` : undefined }}>
          <Brackets at={76} size={110} color="#8FA0FF" gap={44}>
            <Rotator items={["Chat", "CLI", "Review", "Grid", "Automations"]} at={80} every={12} height={120} style={{ fontFamily: line, fontWeight: 500, fontSize: 112, letterSpacing: "-0.03em", color: "#fff", lineHeight: "120px" }} />
          </Brackets>
        </AbsoluteFill>
      )}
      {f >= 148 && (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
          <div style={{ position: "relative", width: 240, height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Block h={150} at={148} color={C.blue} style={{ position: "absolute", opacity: 1 - markIn }} />
            <div style={{ opacity: markIn }}>
              <GyroMark size={220} assembleAt={160} color="#fff" />
            </div>
          </div>
          <div style={{ marginTop: 40, fontFamily: line, fontWeight: 500, fontSize: 96, letterSpacing: "-0.03em", color: "#fff", ...blurIn(f, 185) }}>Gyro</div>
          <div style={{ marginTop: 18, fontFamily: "'Geist Mono', monospace", fontSize: 30, color: "#8FA0FF", letterSpacing: "0.06em" }}>
            <Decode text="usegyro.io" at={205} />
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
