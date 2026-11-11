import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame } from "remotion";
import { Camera, clamp } from "../ui/motion";
import { Say } from "../ui/kinetic";
import { SiteBg } from "../ui/site";
import { Bars, Region, Win } from "../ui/win";
import { C, inOut, mono, prog, text } from "../ui/theme";

/**
 * Idle work. The sentence first, then the camera tilts down into an editor:
 * a cursor closes two tabs, their live dots go quiet, and the camera tracks
 * across to the activity panel as the meter calms. Pull out to the caption.
 */
export const IDLE_FRAMES = 290;

const ED = { x: 310, y: 1160, w: 1300, h: 740 };
const BAR = 54;
const TAB_W = 250;
const TAB_H = 66;
const TABS = ["sidebar.tsx", "app.rs", "menu.tsx", "theme.css"];
const CLOSE: Record<number, number> = { 3: 120, 2: 146 }; // tab → click frame
const PANEL_X = 900; // inside the editor body
const CAPTION = 224;

const closedP = (frame: number, i: number) => (CLOSE[i] === undefined ? 0 : prog(frame, CLOSE[i] + 2, CLOSE[i] + 12, inOut));
const collapseP = (frame: number, i: number) => (CLOSE[i] === undefined ? 0 : prog(frame, CLOSE[i] + 8, CLOSE[i] + 22, inOut));

const Dot: React.FC<{ off: number; size?: number }> = ({ off, size = 16 }) => {
  const frame = useCurrentFrame();
  const pulse = (frame % 30) / 30;
  return (
    <span style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, border: `2px solid ${C.green}`, scale: 1 + pulse * 1.4, opacity: (1 - pulse) * (1 - off) }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: interpolateColors(off, [0, 1], [C.green, "#C3C9D3"]) }} />
    </span>
  );
};

const Tab: React.FC<{ i: number }> = ({ i }) => {
  const frame = useCurrentFrame();
  const off = closedP(frame, i);
  const gone = collapseP(frame, i);
  const press = CLOSE[i] === undefined ? 0 : interpolate(frame, [CLOSE[i] - 2, CLOSE[i], CLOSE[i] + 5], [0, 1, 0], clamp);
  return (
    <div style={{ width: TAB_W * (1 - gone), height: TAB_H, overflow: "hidden", flexShrink: 0, opacity: 1 - gone }}>
      <div
        style={{
          width: TAB_W,
          height: TAB_H,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 20px",
          borderRight: `1.5px solid ${C.line}`,
          background: i === 0 ? "#fff" : "#FAFAFC",
          scale: 1 - press * 0.04,
        }}
      >
        <Dot off={off} />
        <span style={{ flex: 1, fontFamily: mono, fontSize: 24, color: off > 0.5 ? C.faint : C.ink }}>{TABS[i]}</span>
        <span style={{ fontFamily: mono, fontSize: 28, color: C.faint }}>×</span>
      </div>
    </div>
  );
};

/** Cursor that visits each tab's × in turn. Positions are in editor-body coordinates. */
const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const xOf = (i: number) => i * TAB_W + TAB_W - 30;
  const y = TAB_H / 2 + 4;
  const a1 = prog(frame, CLOSE[3] - 22, CLOSE[3] - 1, inOut);
  const a2 = prog(frame, CLOSE[2] - 16, CLOSE[2] - 1, inOut);
  const cx = interpolate(a2, [0, 1], [interpolate(a1, [0, 1], [xOf(3) + 160, xOf(3)]), xOf(2)]);
  const cy = interpolate(a1, [0, 1], [y + 220, y]);
  const leave = prog(frame, CLOSE[2] + 10, CLOSE[2] + 28, inOut);
  const clickAt = frame >= CLOSE[2] ? CLOSE[2] : CLOSE[3];
  const ring = prog(frame, clickAt, clickAt + 14);
  const press = interpolate(frame - clickAt, [-2, 0, 5], [0, 1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: cx + leave * 200, top: cy + leave * 200, opacity: prog(frame, CLOSE[3] - 26, CLOSE[3] - 18) * (1 - leave), zIndex: 3 }}>
      <span
        style={{
          position: "absolute",
          left: -24,
          top: -24,
          width: 48,
          height: 48,
          borderRadius: 99,
          border: `3px solid ${C.blue}`,
          opacity: frame >= clickAt && ring < 1 ? 1 - ring : 0,
          scale: 0.4 + ring * 1.3,
        }}
      />
      <svg width="32" height="38" viewBox="0 0 17 20" style={{ position: "absolute", left: -3, top: -2, scale: 1 - press * 0.15, filter: "drop-shadow(0 4px 6px rgba(16,20,42,0.3))" }}>
        <path d="M1 1 L1 16 L5 12.4 L7.9 18.6 L10.6 17.4 L7.8 11.3 L13 11.3 Z" fill="#10142A" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

/** The activity panel: one row per open tab, and a meter that calms. */
const Activity: React.FC = () => {
  const frame = useCurrentFrame();
  const calm = prog(frame, 152, 196, inOut);
  const busy = interpolateColors(calm, [0, 1], [C.coral, C.blue]);
  return (
    <div style={{ position: "absolute", left: PANEL_X, right: 0, top: TAB_H, bottom: 0, borderLeft: `1.5px solid ${C.line}`, background: "#FBFBFD", padding: "36px 40px", fontFamily: text }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 28, fontWeight: 560, color: C.ink }}>Activity</span>
        <span style={{ fontSize: 22, fontWeight: 500, padding: "6px 14px", borderRadius: 99, color: busy, background: calm > 0.5 ? C.blueSoft : C.coralSoft }}>
          {calm > 0.5 ? "Quiet" : "Busy"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 130, marginTop: 34 }}>
        {Array.from({ length: 12 }).map((_, i) => {
          const b = 0.3 + 0.7 * Math.abs(Math.sin(frame * 0.22 + i * 1.3));
          return <span key={i} style={{ width: 16, height: 12 + 110 * b * (1 - calm * 0.86), borderRadius: 6, background: busy }} />;
        })}
      </div>
      <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 22 }}>
        {TABS.map((name, i) => {
          const off = closedP(frame, i);
          return (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Dot off={off} size={14} />
              <span style={{ flex: 1, fontFamily: mono, fontSize: 22, color: off > 0.5 ? C.faint : C.ink }}>{name}</span>
              <span style={{ fontSize: 20, color: off > 0.5 ? C.faint : C.green }}>{off > 0.5 ? "stopped" : "working"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Editor: React.FC = () => (
  <Win x={ED.x} y={ED.y} w={ED.w} h={ED.h} title="Gyro">
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: TAB_H, display: "flex", borderBottom: `1.5px solid ${C.line}`, background: "#FAFAFC" }}>
        {TABS.map((_, i) => (
          <Tab key={i} i={i} />
        ))}
      </div>
      <div style={{ position: "absolute", left: 50, top: TAB_H + 44, display: "flex", gap: 30 }}>
        <Bars widths={[20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]} color="#EDEEF3" h={12} gap={26} />
        <Bars widths={[260, 420, 360, 180, 520, 470, 300, 0, 380, 560, 240, 330]} h={12} gap={26} />
      </div>
      <Activity />
      <Cursor />
    </Win>
);

export const IdleBeat: React.FC = () => (
  <AbsoluteFill>
    <SiteBg />
    <Camera
      keys={[
        [0, 960, 540, 1],
        [82, 960, 562, 1.06],
        [104, 760, ED.y + BAR + 120, 1.7],
        [148, 800, ED.y + BAR + 120, 1.68],
        [168, ED.x + PANEL_X + 200, 1570, 1.5],
        [204, ED.x + PANEL_X + 190, 1560, 1.48],
        [228, 960, 1600, 1.0],
        [IDLE_FRAMES, 960, 1600, 1.03],
      ]}
    >
      <Say
        at={6}
        out={84}
        size={120}
        lines={[
          ["Close", "a", "tab,"],
          ["it", "stops", { t: "working.", color: C.blue }],
        ]}
      />
      <Editor />
      <Region y={1080}>
        <Say at={CAPTION} size={72} y={380} lines={[["Less", "work", "in", "the", { t: "background.", color: C.blue }]]} />
      </Region>
    </Camera>
  </AbsoluteFill>
);
