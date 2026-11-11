import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Camera, Odometer } from "../ui/motion";
import { Say } from "../ui/kinetic";
import { SiteBg } from "../ui/site";
import { Win } from "../ui/win";
import { C, inOut, out, prog, text } from "../ui/theme";

/**
 * The safety net under the rebuild, as a checklist. The camera rides close
 * along each row as it ticks, then pulls back for the sentence it adds up to.
 */
export const STATS_FRAMES = 262;

const CARD = { x: 410, y: 300, w: 1100, h: 560 };
const ROW_Y = [430, 560, 690]; // stage y of each row's centre
const ROW_AT = [12, 70, 128];
const HEAD = 182;

type Row = { label: string; sub: string; to: number; digits: number; unit: string };
const ROWS: Row[] = [
  { label: "App commands", sub: "Same names as before", to: 197, digits: 3, unit: "kept" },
  { label: "Tests", sub: "Next to the code they check", to: 9744, digits: 4, unit: "lines" },
  { label: "New warnings", sub: "Checked at every step", to: 0, digits: 1, unit: "" },
];

const CheckDraw: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const ring = prog(frame, at, at + 16, out);
  const tick = prog(frame, at + 10, at + 24, inOut);
  return (
    <svg width={72} height={72} viewBox="0 0 72 72" style={{ flexShrink: 0 }}>
      <circle cx={36} cy={36} r={33} fill={C.greenSoft} opacity={ring} />
      <circle cx={36} cy={36} r={33} fill="none" stroke={C.green} strokeWidth={3} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - ring} transform="rotate(-90 36 36)" />
      <path d="M22 37 l9.5 9.5 L50 27" fill="none" stroke={C.green} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - tick} />
    </svg>
  );
};

const CheckRow: React.FC<{ row: Row; i: number }> = ({ row, i }) => {
  const frame = useCurrentFrame();
  const at = ROW_AT[i];
  const p = prog(frame, at, at + 18, out);
  const v = interpolate(prog(frame, at + 8, at + 38, inOut), [0, 1], [0, row.to]);
  const pv = interpolate(prog(frame - 1, at + 8, at + 38, inOut), [0, 1], [0, row.to]);
  return (
    <div
      style={{
        position: "absolute",
        left: 60,
        right: 60,
        top: ROW_Y[i] - CARD.y - 54 - 50,
        height: 100,
        display: "flex",
        alignItems: "center",
        gap: 30,
        opacity: p,
        translate: `0 ${(1 - p) * 24}px`,
        filter: p < 0.99 ? `blur(${(1 - p) * 10}px)` : undefined,
        borderBottom: i < 2 ? `1.5px solid ${C.line}` : undefined,
      }}
    >
      <CheckDraw at={at + 4} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, fontFamily: text }}>
        <span style={{ fontSize: 40, fontWeight: 560, color: C.ink, letterSpacing: -0.6 }}>{row.label}</span>
        <span style={{ fontSize: 26, color: C.muted }}>{row.sub}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
        <Odometer value={v} prev={pv} digits={row.digits} size={60} weight={600} color={row.to === 0 ? C.green : C.ink} />
        {row.unit && <span style={{ fontFamily: text, fontSize: 30, color: C.muted }}>{row.unit}</span>}
      </div>
    </div>
  );
};

export const StatsBeat: React.FC = () => (
  <AbsoluteFill>
    <SiteBg />
    <Camera
      keys={[
        [0, 960, ROW_Y[0], 1.5],
        [52, 990, ROW_Y[0], 1.47],
        [68, 960, ROW_Y[1], 1.5],
        [110, 990, ROW_Y[1], 1.47],
        [126, 960, ROW_Y[2], 1.5],
        [164, 990, ROW_Y[2], 1.47],
        [188, 960, 480, 1.08],
        [STATS_FRAMES, 960, 476, 1.11],
      ]}
    >
      <Win x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} title="Checks">
        {ROWS.map((row, i) => (
          <CheckRow key={row.label} row={row} i={i} />
        ))}
      </Win>
      <Say at={HEAD} size={96} y={-370} lines={[["Nothing", "breaks", "for", { t: "you.", color: C.blue }]]} />
    </Camera>
  </AbsoluteFill>
);
