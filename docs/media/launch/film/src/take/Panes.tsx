// 12–26s. "Meet Gyro", the cursor splits the white into four panes, agents run side by side.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { panes } from "../cut/data";
import { C, mono, out } from "../ui/theme";
import { BRANCHES, Chip, Key, TakeCam, TakePane, TypeCard, camAt, p01 } from "./kit";

export const PANES = 430;
const DEL = 100;
const CROSS: [number, number] = [118, 150];
const FILL = [150, 169, 188, 206];
const PULL: [number, number] = [250, 287];
const LINE2 = 292;
const DIVE: [number, number] = [380, 416];

const M = 30;
const G = 14;
const cw = (1920 - 2 * M - G) / 2;
const ch = (1080 - 2 * M - G) / 2;
const cell = (i: number) => ({ x: M + (i % 2) * (cw + G), y: M + Math.floor(i / 2) * (ch + G) });
const HEAD = 46;
const PS = 0.86; // pane scale inside the cell
const MODEL: Record<string, string> = { "claude-opus-5": "Claude Opus 5", "gpt-5.6": "GPT-5.6", "claude-sonnet-5": "Claude Sonnet 5" };

/** Center of pane 0's branch chip, in world space. Review picks up from here. */
export const CHIP0: [number, number] = [cell(0).x + 16 + 100, cell(0).y + HEAD / 2];
export const CHIP_SIZE = 15;
export const DIVE_SCALE = 3.0;

const keys: Key[] = [
  [0, 960, 540, 1],
  [PULL[0], 960, 540, 1],
  [PULL[1], 960, 490, 0.82],
  [DIVE[0], 960, 490, 0.82],
  [DIVE[1], CHIP0[0], CHIP0[1], DIVE_SCALE],
];

export const Panes: React.FC = () => {
  const f = useCurrentFrame();
  const cam = camAt(keys, f);
  const cross = p01(f, CROSS[0], CROSS[1], out);
  const fade = 1 - p01(f, DIVE[0], DIVE[0] + 26);
  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <TakeCam cam={cam}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, background: C.canvas, opacity: p01(f, CROSS[0], FILL[0]) * fade }} />
        {/* The cursor becomes the dividers. */}
        {f >= CROSS[0] && (
          <div style={{ opacity: 1 - p01(f, FILL[3], FILL[3] + 20) }}>
            <div style={{ position: "absolute", left: 960 - 3, top: 540 - 540 * cross, width: 6, height: 1080 * cross, background: C.blue, borderRadius: 3 }} />
            <div style={{ position: "absolute", top: 540 - 3, left: 960 - 960 * cross, height: 6, width: 1920 * cross, background: C.blue, borderRadius: 3 }} />
          </div>
        )}
        {FILL.map((at, i) => {
          if (f < at) return null;
          const { x, y } = cell(i);
          const k = p01(f, at, at + 16, out);
          const op = i === 0 ? 1 : fade;
          const p = panes[i];
          return (
            <div key={i} style={{ position: "absolute", left: x, top: y, width: cw, height: ch, borderRadius: 14, overflow: "hidden", background: "#fff", boxShadow: "0 0 0 1px rgba(16,20,42,0.08), 0 12px 30px -16px rgba(16,20,42,0.3)", opacity: k * op, transform: `translateY(${(1 - k) * 18}px)` }}>
              <div style={{ height: HEAD, display: "flex", alignItems: "center", gap: 12, padding: "0 16px", borderBottom: `1px solid ${C.line}`, opacity: i === 0 ? fade : 1 }}>
                <span style={{ width: 200 }} />
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: mono, fontSize: 14, color: C.muted }}>{MODEL[p.modelId]}</span>
              </div>
              <div style={{ position: "absolute", left: 16, top: HEAD / 2, transform: "translateY(-50%)" }}>
                <Chip label={BRANCHES[i]} size={CHIP_SIZE} style={{ position: "relative", left: 0 }} />
              </div>
              <div style={{ position: "absolute", left: 0, top: HEAD, width: cw / PS, height: (ch - HEAD) / PS, transformOrigin: "0 0", transform: `scale(${PS})`, opacity: i === 0 ? fade : 1 }}>
                <TakePane i={i} t={f - at} w={cw / PS} h={(ch - HEAD) / PS} />
              </div>
            </div>
          );
        })}
      </TakeCam>
      <TypeCard text="Meet Gyro" at={0} cps={0.3} del={DEL} until={CROSS[0] + 2} caretUntil={CROSS[0]} size={150} />
      <TypeCard text="Run them side by side." at={LINE2} cps={0.42} until={DIVE[0]} size={60} y={92} />
    </AbsoluteFill>
  );
};
