// "Working in 3, 4, 5 different apps has become normal." The Dock fills with AI apps, an editor and
// a terminal. The camera drops to the Dock, the pointer drags Claude to the Trash and the rest follow
// in a magnetic chain. Only Gyro is left. Push in: "One app."
import { useFrame } from "../pace";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { ProviderLogo } from "@gyro-ui/workspace-sidebar.tsx";
import { Block, line } from "../ui/skale";
import { C, inOut, mono, out } from "../ui/theme";
import { clockText } from "./Open";
import { Key, MenuBar, TakeCam, bounce, camAt, p01, toScreen } from "./kit";

export const APPS = 330;
const NUM = [0, 40, 66]; // 3 → 4 → 5
const GRAB = 144; // pointer presses on Claude
const LIFT = 152;
const LAND = 186; // leader reaches the Trash
const SINK = 194; // leader is inside
const LAG = 3; // chain spacing in frames
const COL: [number, number] = [222, 242]; // empty slots close
const ONE = 262;
const OUT: [number, number] = [300, 326];

const DY = 1032; // dock icon centre
const P = 78; // slot pitch
const IC = 64; // icon size

type App = { name: string; logo: React.ReactNode; bg: string; tint: string; at: number };
const L = (id: string) => <ProviderLogo providerId={id as never} label={id} />;
const glyph = (s: string, color: string) => <span style={{ fontFamily: mono, fontWeight: 600, fontSize: 24, color, lineHeight: 1 }}>{s}</span>;
const APPS_: App[] = [
  { name: "Claude", logo: L("anthropic"), tint: "#D97757", bg: "linear-gradient(180deg,#FFFFFF,#F6EEE8)", at: 8 },
  { name: "ChatGPT", logo: L("openai"), tint: "#10142A", bg: "linear-gradient(180deg,#FFFFFF,#EEF0F3)", at: 14 },
  { name: "Editor", logo: glyph("{ }", "#fff"), tint: "#fff", bg: "linear-gradient(160deg,#3C8DFF,#1F5FD6)", at: 20 },
  { name: "Gemini", logo: L("gemini"), tint: "#4F7DF3", bg: "linear-gradient(180deg,#FFFFFF,#EAF0FE)", at: NUM[1] + 2 },
  { name: "Grok", logo: L("xai"), tint: "#F4F4F6", bg: "linear-gradient(180deg,#2A2C33,#111216)", at: NUM[2] + 2 },
  { name: "Terminal", logo: glyph(">_", "#E8E8E8"), tint: "#E8E8E8", bg: "linear-gradient(180deg,#2B2F36,#14161A)", at: NUM[2] + 8 },
];

/** Slot centres for [Gyro, ...apps, separator, Trash] at frame f. */
const layout = (f: number) => {
  const col = p01(f, COL[0], COL[1]);
  const w = [1, ...APPS_.map((a) => p01(f, a.at, a.at + 12, out) * (1 - col)), 0.32, 1];
  const total = w.reduce((s, v) => s + v, 0) * P;
  let x = 960 - total / 2;
  const xs = w.map((v) => {
    const c = x + (v * P) / 2;
    x += v * P;
    return c;
  });
  return { xs, total, w };
};
const fixed = layout(GRAB); // positions stay put while dragging
const X0 = fixed.xs[1];
const TX = fixed.xs[fixed.xs.length - 1];

type Pose = { x: number; y: number; s: number; r: number; o: number };
/** The leader (Claude) on its way to the Trash at frame t. */
const leader = (t: number): Pose => {
  const lift = p01(t, GRAB, LIFT, out);
  const u = p01(t, LIFT, LAND, inOut);
  const drop = p01(t, LAND, SINK, (k) => k * k);
  return {
    x: X0 + (TX - X0) * u,
    y: DY - 46 * lift - 130 * Math.sin(Math.PI * u) + 46 * drop,
    s: (1 + 0.14 * lift) * (1 - 0.8 * drop),
    r: -9 * Math.sin(Math.PI * u) + drop * 20,
    o: 1 - p01(t, SINK - 3, SINK),
  };
};
/** When follower j joins the chain: the trail passes overhead. */
const attachAt = (j: number) => {
  const own = fixed.xs[1 + j];
  for (let t = GRAB; t < 260; t++) if (leader(t - LAG * j).x >= own + 4) return t;
  return 260;
};
const ATTACH = APPS_.map((_, j) => attachAt(j));
const pose = (j: number, f: number): Pose | null => {
  const own = { x: fixed.xs[1 + j], y: DY, s: 1, r: 0, o: 1 };
  if (j === 0) return f < GRAB ? null : leader(f);
  const s0 = ATTACH[j];
  if (f < s0 - 12) return null;
  const a = p01(f, s0, s0 + 8, out);
  const tr = leader(f - LAG * j);
  const tug = f < s0 ? Math.sin(p01(f, s0 - 12, s0) * Math.PI * 3) * 3 : 0; // the magnet tugs first
  return { x: own.x + (tr.x - own.x) * a + tug, y: own.y + (tr.y - own.y) * a - 8 * p01(f, s0 - 12, s0) * (1 - a), s: 1 + (tr.s - 1) * a, r: tr.r * a, o: tr.o };
};
const arrivals = APPS_.map((_, j) => LAND + 4 + LAG * j);

const Tile: React.FC<{ a: App; size: number }> = ({ a, size }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.23, background: a.bg, color: a.tint, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.12), 0 2px 5px rgba(0,0,0,0.18)" }}>
    <div className="apps-logo" style={{ transform: `scale(${size / IC})` }}>{a.logo}</div>
  </div>
);

const GyroIcon: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ position: "relative", width: size, height: size }}>
    <Img src={staticFile("gyro-app-icon.png")} style={{ position: "absolute", left: "-12%", top: "-12%", width: "124%", height: "124%" }} />
  </div>
);

/** macOS-style mesh Trash; `full` adds the crumpled papers. */
const Trash: React.FC<{ size: number; full: boolean }> = ({ size, full }) => (
  <svg viewBox="0 0 64 64" width={size} height={size} style={{ overflow: "visible", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.2))" }}>
    <defs>
      <linearGradient id="trash-body" x1="0" x2="1">
        <stop offset="0" stopColor="#E6E9EF" />
        <stop offset=".5" stopColor="#FDFDFE" />
        <stop offset="1" stopColor="#CDD2DC" />
      </linearGradient>
    </defs>
    {full && (
      <g>
        <path d="M16 12 l6 -9 l7 4 l5 -6 l6 7 l8 -3 l1 10 Z" fill="#F7F7F9" stroke="#C9CED8" strokeWidth=".8" />
        <path d="M22 11 l4 -6 l6 5" fill="none" stroke="#D6DAE2" strokeWidth=".8" />
        <rect x="35" y="2" width="9" height="9" rx="2.4" fill="#D97757" transform="rotate(18 40 7)" />
        <rect x="19" y="4" width="8" height="8" rx="2.2" fill="#1F5FD6" transform="rotate(-16 23 8)" />
      </g>
    )}
    <path d="M10 13 L15 58 Q15.6 62 20 62 L44 62 Q48.4 62 49 58 L54 13 Z" fill="url(#trash-body)" stroke="#AEB5C4" strokeWidth="1" />
    {Array.from({ length: 7 }, (_, k) => (
      <path key={k} d={`M${17 + k * 5} 18 L${19.5 + k * 4.2} 57`} stroke="#B7BDCA" strokeWidth="1.3" strokeLinecap="round" />
    ))}
    <ellipse cx="32" cy="13" rx="22" ry="4.2" fill="#9AA2B2" />
    <ellipse cx="32" cy="13" rx="20" ry="3" fill="#6E7688" />
  </svg>
);

const Arrow: React.FC<{ x: number; y: number; o: number; down: boolean }> = ({ x, y, o, down }) => (
  <div style={{ position: "absolute", left: x - 2, top: y - 2, width: 30, height: 39, transformOrigin: "2px 2px", transform: `scale(${down ? 0.9 : 1})`, opacity: o, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))" }}>
    <svg viewBox="0 0 24 31" width="100%" height="100%">
      <path d="M1.5 1.5 L1.5 25 L7.6 19.4 L11.6 28.8 L15.6 27.1 L11.7 18 L19.8 18 Z" fill="#000" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  </div>
);

const keys: Key[] = [
  [0, 960, 500, 1.0],
  [104, 960, 540, 1.07],
  [136, 960, 985, 1.9],
  [COL[0], 960, 985, 1.9],
  [ONE + 6, 960, 990, 3.0],
  [APPS, 960, 988, 3.15],
];

/** Pointer in world space. */
const pointerAt = (f: number): [number, number] => {
  if (f < 140) {
    const k = p01(f, 108, 140);
    return [1240 + (X0 + 8 - 1240) * k, 820 + (DY + 6 - 820) * k];
  }
  if (f < SINK) {
    const l = leader(Math.min(f, LAND));
    return [l.x + 8, l.y + 6];
  }
  const k = p01(f, SINK, 220, out);
  const l = leader(LAND);
  return [l.x + 8 + 90 * k, l.y + 6 - 70 * k];
};

export const Apps: React.FC = () => {
  const f = useFrame();
  const cam = camAt(keys, f);
  const { xs, total, w } = layout(f);
  const num = f < NUM[1] ? 3 : f < NUM[2] ? 4 : 5;
  const roll = (at: number) => p01(f, at - 8, at, out);
  const pre = "Working in ";
  const post = " different apps";
  const l2 = "has become normal.";
  const typed = Math.max(0, Math.floor((f - 2) * 0.9));
  const full = pre + "#" + post + "\n" + l2;
  const n = Math.max(0, Math.min(full.length, typed));
  const [a1, a2] = full.slice(0, n).split("\n");
  const SIZE = 84;
  const font: React.CSSProperties = { fontFamily: line, fontWeight: 500, fontSize: SIZE, letterSpacing: "-0.035em", color: C.ink, lineHeight: 1.1, whiteSpace: "pre" };
  const hasNum = a1.includes("#");
  const [b, c] = a1.split("#");
  const caretOn = f < 140;

  // Pointer + dock magnification.
  const [pwx, pwy] = pointerAt(f);
  const [psx, psy] = toScreen(cam, pwx, pwy);
  const pOp = Math.min(p01(f, 108, 114), 1 - p01(f, 206, 216));
  const hoverX = f >= 118 && f < GRAB ? pwx : undefined;
  const mag = (x: number) => (hoverX === undefined ? 1 : 1 + 0.2 * Math.max(0, 1 - Math.abs(hoverX - x) / 130) ** 2);

  // Trash fills and hops with each arrival.
  const fullTrash = f >= arrivals[0] - 2;
  const hop = arrivals.reduce((s, a) => s + (f >= a && f < a + 10 ? Math.sin(((f - a) / 10) * Math.PI) * 7 : 0), 0);
  const squash = 1 + arrivals.reduce((s, a) => s + (f >= a && f < a + 8 ? Math.sin(((f - a) / 8) * Math.PI) * 0.08 : 0), 0);
  const gyroHop = bounce(f, ONE - 18) * 0.7;
  const gyroOut = p01(f, OUT[0], OUT[1]);
  const dockW = total + 18;
  const sep = xs[xs.length - 2];

  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <style>{`.apps-logo .gyro-provider-logo{display:flex;width:36px;height:36px;color:inherit !important}.apps-logo svg{width:36px;height:36px}`}</style>
      <TakeCam cam={cam}>
        <div
          style={{
            position: "absolute", left: -600, top: -300, width: 3120, height: 1900,
            background:
              "radial-gradient(1200px 800px at 946px 430px, #D9E0FB 0%, rgba(217,224,251,0) 60%), radial-gradient(1000px 700px at 2290px 624px, #F8E1D6 0%, rgba(248,225,214,0) 60%), radial-gradient(1400px 900px at 1560px 1488px, #C7D0F4 0%, rgba(199,208,244,0) 60%), #ECEEF7",
          }}
        />
        {/* The line, typed on the wallpaper. */}
        <div style={{ position: "absolute", left: 960, top: 430, transform: "translate(-50%,-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div style={{ ...font, display: "flex", alignItems: "center", minHeight: SIZE * 1.1 }}>
            <span>{b}</span>
            {hasNum && (
              <span style={{ display: "inline-block", position: "relative", width: SIZE * 0.62, height: SIZE * 1.1, overflow: "hidden", color: C.blue }}>
                {[3, 4, 5].map((v, k) => {
                  const cur = v === num;
                  const prev = v === num - 1;
                  const r = roll(NUM[num - 3]);
                  const y = cur ? (num === 3 ? 0 : (1 - r) * SIZE * 1.1) : prev ? -r * SIZE * 1.1 : SIZE * 2;
                  return <span key={k} style={{ position: "absolute", left: 0, right: 0, textAlign: "center", top: y }}>{v}</span>;
                })}
              </span>
            )}
            {c !== undefined && <span>{c}</span>}
            {a2 === undefined && caretOn && <Block h={SIZE * 0.92} at={0} solid={n < full.length} color={C.blue} style={{ marginLeft: SIZE * 0.08 }} />}
          </div>
          <div style={{ ...font, display: "flex", alignItems: "center", minHeight: SIZE * 1.1 }}>
            <span>{a2 ?? ""}</span>
            {a2 !== undefined && caretOn && <Block h={SIZE * 0.92} at={0} solid={n < full.length} color={C.blue} style={{ marginLeft: SIZE * 0.08 }} />}
          </div>
        </div>

        {/* Dock */}
        <div style={{ position: "absolute", left: 960 - dockW / 2, top: DY - 42, width: dockW, height: 84, borderRadius: 24, background: "rgba(255,255,255,0.42)", border: "1px solid rgba(255,255,255,0.65)", boxShadow: "0 10px 40px rgba(20,24,60,0.18)", backdropFilter: "blur(20px)" }} />
        <div style={{ position: "absolute", left: sep - 0.5, top: DY - 30, width: 1, height: 60, background: "rgba(16,20,42,0.16)" }} />
        {/* Gyro */}
        {(() => {
          const s = IC * mag(xs[0]);
          return (
            <>
              <div style={{ position: "absolute", left: xs[0] - s / 2, top: DY + IC / 2 - s - 2 - gyroHop, transform: `scale(${1 + 0.05 * Math.sin(p01(f, ONE - 18, ONE + 10) * Math.PI)})` }}>
                <GyroIcon size={s} />
              </div>
              <div style={{ position: "absolute", left: xs[0] - 2, top: DY + 35, width: 4, height: 4, borderRadius: 2, background: "rgba(20,24,40,0.7)" }} />
            </>
          );
        })()}
        {/* Apps sitting in the Dock */}
        {APPS_.map((a, j) => {
          if (pose(j, f) && (j === 0 || f >= ATTACH[j])) return null;
          const k = w[1 + j];
          if (k <= 0.01 || f >= COL[0]) return null;
          const popS = p01(f, a.at, a.at + 14, (t) => 1 - (1 - t) ** 3 * Math.cos(t * 7));
          const p = pose(j, f);
          const x = p ? p.x : xs[1 + j];
          const y = p ? p.y : DY;
          const s = IC * mag(x) * Math.max(0, popS);
          return (
            <div key={a.name} style={{ position: "absolute", left: x - s / 2, top: y + IC / 2 - s - 2 }}>
              <Tile a={a} size={s} />
            </div>
          );
        })}
        {/* Trash */}
        <div style={{ position: "absolute", left: xs[xs.length - 1] - IC / 2, top: DY - IC / 2 - 2 - hop, width: IC, height: IC, transformOrigin: "50% 100%", transform: `scale(${squash},${2 - squash})` }}>
          <Trash size={IC} full={fullTrash} />
        </div>
        {/* The chain, in flight */}
        {APPS_.map((a, j) => {
          const p = pose(j, f);
          if (!p || (j > 0 && f < ATTACH[j]) || p.o <= 0) return null;
          return (
            <div key={a.name} style={{ position: "absolute", left: p.x - IC / 2, top: p.y - IC / 2 - 2, transform: `scale(${p.s}) rotate(${p.r}deg)`, opacity: p.o, filter: "drop-shadow(0 14px 18px rgba(16,20,42,0.28))" }}>
              <Tile a={a} size={IC} />
            </div>
          );
        })}
        {/* One app. */}
        <div style={{ position: "absolute", left: 760, width: 400, top: DY - 118, textAlign: "center", fontFamily: line, fontWeight: 500, fontSize: 30, letterSpacing: "-0.03em", color: C.ink, opacity: p01(f, ONE, ONE + 14), transform: `translateY(${(1 - p01(f, ONE, ONE + 18, out)) * 8}px)` }}>
          One app.
        </div>
        <MenuBar clock={clockText(9 * 60 + 42)} />
      </TakeCam>
      {pOp > 0 && <Arrow x={psx} y={psy} o={pOp} down={f >= GRAB && f < SINK} />}
      <AbsoluteFill style={{ background: "#fff", opacity: Math.max(1 - p01(f, 0, 18), gyroOut) }} />
    </AbsoluteFill>
  );
};
