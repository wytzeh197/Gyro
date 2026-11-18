// Shared pieces for the continuous take: camera, pointer, typed cards, the Mac desktop.
import { useFrame } from "../pace";
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile } from "remotion";
import { ChatSurface } from "@gyro-ui/surfaces.tsx";
import { config } from "../fixtures/config.js";
import { useAppTheme } from "../app/GyroApp";
import { W, paneBusy, paneEvents, panes } from "../cut/data";
import { Block, line } from "../ui/skale";
import { C, inOut, mono, out, text } from "../ui/theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
/** 96 BPM at 30fps: one beat is 18.75 frames. */
export const B = (n: number) => Math.round(n * 18.75);
export const p01 = (f: number, a: number, b: number, easing: (t: number) => number = inOut) => interpolate(f, [a, b], [0, 1], { ...clamp, easing });

// ---- Camera ---------------------------------------------------------------
export type Key = [number, number, number, number]; // frame, cx, cy, scale
export type Cam = { cx: number; cy: number; s: number };
export const camAt = (keys: Key[], f: number): Cam => {
  if (keys.length === 1 || f <= keys[0][0]) return { cx: keys[0][1], cy: keys[0][2], s: keys[0][3] };
  const last = keys[keys.length - 1];
  if (f >= last[0]) return { cx: last[1], cy: last[2], s: last[3] };
  let i = 0;
  while (f > keys[i + 1][0]) i++;
  const [a, b] = [keys[i], keys[i + 1]];
  const t = inOut((f - a[0]) / (b[0] - a[0]));
  return { cx: a[1] + (b[1] - a[1]) * t, cy: a[2] + (b[2] - a[2]) * t, s: Math.exp(Math.log(a[3]) + (Math.log(b[3]) - Math.log(a[3])) * t) };
};
export const toScreen = (c: Cam, x: number, y: number): [number, number] => [960 + (x - c.cx) * c.s, 540 + (y - c.cy) * c.s];

/** Calm camera: no blur, no tilt. Children are laid out in a 1920 × 1080 world. */
export const TakeCam: React.FC<{ cam: Cam; children: React.ReactNode }> = ({ cam, children }) => (
  <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(960px,540px) scale(${cam.s}) translate(${-cam.cx}px,${-cam.cy}px)` }}>{children}</div>
);

// ---- Pointer --------------------------------------------------------------
/** macOS-style arrow in screen space. `keys` are world points; the pointer stays a constant size. */
export const TakePointer: React.FC<{ cam: Cam; keys: [number, number, number][]; clicks?: number[]; at?: number; until?: number }> = ({ cam, keys, clicks = [], at = keys[0][0], until = 1e9 }) => {
  const f = useFrame();
  if (f < at || f > until + 8) return null;
  const fs = keys.map((k) => k[0]);
  const wx = keys.length > 1 ? interpolate(f, fs, keys.map((k) => k[1]), { ...clamp, easing: inOut }) : keys[0][1];
  const wy = keys.length > 1 ? interpolate(f, fs, keys.map((k) => k[2]), { ...clamp, easing: inOut }) : keys[0][2];
  const [x, y] = toScreen(cam, wx, wy);
  const op = Math.min(p01(f, at, at + 6), 1 - p01(f, until, until + 8));
  const dip = clicks.some((c) => f >= c && f < c + 5) ? 0.9 : 1;
  const size = 30;
  return (
    <>
      {clicks.map((c) => {
        const r = p01(f, c, c + 16, out);
        return f >= c && f < c + 16 ? (
          <div key={c} style={{ position: "absolute", left: x - 34 * r, top: y - 34 * r, width: 68 * r, height: 68 * r, borderRadius: "50%", background: "rgba(16,20,42,0.16)", opacity: (1 - r) * op }} />
        ) : null;
      })}
      <div style={{ position: "absolute", left: x - 2, top: y - 2, width: size, height: size * 1.3, transformOrigin: "2px 2px", transform: `scale(${dip})`, opacity: op, filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))" }}>
        <svg viewBox="0 0 24 31" width="100%" height="100%">
          <path d="M1.5 1.5 L1.5 25 L7.6 19.4 L11.6 28.8 L15.6 27.1 L11.7 18 L19.8 18 Z" fill="#000" stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
};

// ---- Typed card -----------------------------------------------------------
/** One line typed with the block cursor. Deletes back from `del` if given. Centered on (x, y). */
export const TypeCard: React.FC<{ text: string; at: number; x?: number; y?: number; size?: number; cps?: number; del?: number; until?: number; color?: string; cursor?: boolean; caretUntil?: number }> = ({
  text: s, at, x = 960, y = 540, size = 120, cps = 0.25, del, until = 1e9, color = C.ink, cursor = true, caretUntil = 1e9,
}) => {
  const f = useFrame();
  if (f < at || f >= until) return null;
  let n = Math.min(s.length, Math.floor((f - at) * cps) + 1);
  if (f < at + 1 / cps) n = f >= at + 4 ? 1 : 0;
  else n = Math.min(s.length, Math.floor((f - at - 4) * cps) + 1);
  if (del !== undefined && f >= del) n = Math.max(0, s.length - Math.floor((f - del) * 0.6));
  const typing = n < s.length && (del === undefined || f < del);
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: "translate(-50%,-50%)", display: "flex", alignItems: "center", gap: size * 0.08, whiteSpace: "pre" }}>
      <span style={{ fontFamily: line, fontWeight: 500, fontSize: size, letterSpacing: "-0.035em", color, lineHeight: 1 }}>{s.slice(0, n)}</span>
      {cursor && f < caretUntil && <Block h={size * 0.92} at={at} solid={typing || (del !== undefined && f >= del)} color={C.blue} />}
    </div>
  );
};

// ---- Branch chip ----------------------------------------------------------
export const Chip: React.FC<{ label: string; size: number; style?: React.CSSProperties }> = ({ label, size, style }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.4, height: size * 1.75, padding: `0 ${size * 0.6}px`, borderRadius: size * 0.45, background: C.blueSoft, color: C.blue, fontFamily: mono, fontSize: size, fontWeight: 500, whiteSpace: "nowrap", ...style }}>
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="5.5" r="1.8" />
      <path d="M4 5.3v5.4M12 7.3c0 3-3 3.2-7 4" />
    </svg>
    {label}
  </div>
);

// ---- Real pane ------------------------------------------------------------
export const BRANCHES = ["fix/checkout-total", "gyro/audit-provider", "gyro/fix-flaky", "gyro/release-notes"];
const noop = () => undefined;
/** One real ChatSurface, rendered at `w × h` app pixels. */
export const TakePane: React.FC<{ i: number; t: number; w: number; h: number }> = ({ i, t, w, h }) => {
  useAppTheme("light");
  const p = panes[i];
  return (
    <div className="film-app" style={{ width: w, height: h, position: "relative", overflow: "hidden", background: "var(--gyro-surface, #fff)" }}>
      <ChatSurface
        config={config as never}
        events={paneEvents(i, Math.max(0, t), 20) as never}
        paneKey={"pane-" + i}
        sessionTitle={p.title}
        workspacePath={W}
        branchName={BRANCHES[i]}
        sessionModel={{ providerId: p.providerId, modelId: p.modelId } as never}
        isTiled
        isComposerSending={paneBusy(i, Math.max(0, t), 20)}
        onPaneDragStart={noop}
        onPaneDragEnd={noop}
        onPanePointerDown={noop}
        onComposerAction={noop}
        onSend={noop}
        shellReady
      />
    </div>
  );
};

// ---- Desktop --------------------------------------------------------------
/** The app window sits at WIN on the desktop, 1280 × 800 at scale 1.1. */
export const WIN = { x: 256, y: 62, s: 1.1 };
export const winPt = (ax: number, ay: number): [number, number] => [WIN.x + ax * WIN.s, WIN.y + ay * WIN.s];

export const DOCK = { y: 1032, icon: 64, pitch: 78, n: 9, gyro: 4 };
export const dockX = (i: number) => 960 + (i - (DOCK.n - 1) / 2) * DOCK.pitch;
export const GYRO_ICON: [number, number] = [dockX(DOCK.gyro), DOCK.y];

const Tile: React.FC<{ bg: string; children?: React.ReactNode; style?: React.CSSProperties }> = ({ bg, children, style }) => (
  <div style={{ width: "100%", height: "100%", borderRadius: "23%", background: bg, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.12), 0 2px 5px rgba(0,0,0,0.18)", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", ...style }}>{children}</div>
);
const ICONS: React.ReactNode[] = [
  <Tile key="files" bg="linear-gradient(180deg,#6FB6FF,#2F7BEA)">
    <svg width="62%" viewBox="0 0 40 32"><path d="M2 6a3 3 0 0 1 3-3h10l4 4h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3Z" fill="#fff" opacity=".95" /><path d="M2 12h36" stroke="#9CC8FF" strokeWidth="2" /></svg>
  </Tile>,
  <Tile key="mail" bg="linear-gradient(180deg,#5FB0FF,#1E6FE8)">
    <svg width="62%" viewBox="0 0 40 28"><rect x="1" y="1" width="38" height="26" rx="3" fill="#fff" /><path d="M2 3l18 13L38 3" fill="none" stroke="#1E6FE8" strokeWidth="2.4" /></svg>
  </Tile>,
  <Tile key="cal" bg="#fff" style={{ flexDirection: "column", justifyContent: "flex-start" }}>
    <div style={{ marginTop: "12%", fontFamily: text, fontSize: 11, fontWeight: 600, color: "#E5483B", letterSpacing: "0.04em" }}>TUE</div>
    <div style={{ fontFamily: text, fontSize: 34, fontWeight: 400, color: "#222", lineHeight: 1 }}>17</div>
  </Tile>,
  <Tile key="notes" bg="linear-gradient(180deg,#FFE27A 0 24%,#FFFDF4 24%)">
    <svg width="70%" viewBox="0 0 40 40" style={{ marginTop: "22%" }}>{[8, 16, 24, 32].map((y) => <path key={y} d={`M2 ${y}h36`} stroke="#E3DCC6" strokeWidth="1.6" />)}</svg>
  </Tile>,
  null, // Gyro
  <Tile key="term" bg="linear-gradient(180deg,#2B2F36,#14161A)" style={{ alignItems: "flex-start", justifyContent: "flex-start" }}>
    <div style={{ fontFamily: mono, fontSize: 15, color: "#E8E8E8", margin: "16% 0 0 16%" }}>{">_"}</div>
  </Tile>,
  <Tile key="web" bg="linear-gradient(180deg,#F4F6FA,#D9DEE8)">
    <svg width="66%" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="none" stroke="#3B82F6" strokeWidth="2.4" /><path d="M3 20h34M20 3c-6 6-6 28 0 34M20 3c6 6 6 28 0 34" fill="none" stroke="#3B82F6" strokeWidth="2" /></svg>
  </Tile>,
  <Tile key="music" bg="linear-gradient(180deg,#FF7A8A,#F2405B)">
    <svg width="50%" viewBox="0 0 30 34"><path d="M10 26V6l16-4v20" fill="none" stroke="#fff" strokeWidth="3" /><circle cx="6.5" cy="26.5" r="4.5" fill="#fff" /><circle cx="22.5" cy="22.5" r="4.5" fill="#fff" /></svg>
  </Tile>,
  <Tile key="set" bg="linear-gradient(180deg,#B9BEC7,#80868F)">
    <svg width="62%" viewBox="0 0 40 40"><g fill="none" stroke="#fff" strokeWidth="3.2">{Array.from({ length: 8 }, (_, k) => <path key={k} d="M20 3v6" transform={`rotate(${k * 45} 20 20)`} />)}<circle cx="20" cy="20" r="10" /></g><circle cx="20" cy="20" r="4" fill="#fff" /></svg>
  </Tile>,
];

/** Bounce height for a dock icon clicked at `at` (two hops). */
export const bounce = (f: number, at?: number) => {
  if (at === undefined || f < at) return 0;
  const t = f - at;
  if (t < 20) return Math.sin((t / 20) * Math.PI) * 34;
  if (t < 34) return Math.sin(((t - 20) / 14) * Math.PI) * 14;
  return 0;
};

export const Dock: React.FC<{ hoverX?: number; bounceAt?: number; gyroRunning?: boolean }> = ({ hoverX, bounceAt, gyroRunning }) => {
  const f = useFrame();
  const w = DOCK.n * DOCK.pitch + 18;
  return (
    <>
      <div style={{ position: "absolute", left: 960 - w / 2, top: DOCK.y - 42, width: w, height: 84, borderRadius: 24, background: "rgba(255,255,255,0.42)", border: "1px solid rgba(255,255,255,0.65)", boxShadow: "0 10px 40px rgba(20,24,60,0.18)", backdropFilter: "blur(20px)" }} />
      {ICONS.map((icon, i) => {
        const cx = dockX(i);
        const d = hoverX === undefined ? 999 : Math.abs(hoverX - cx);
        const mag = 1 + 0.22 * Math.max(0, 1 - d / 150) ** 2;
        const hop = i === DOCK.gyro ? bounce(f, bounceAt) : 0;
        const size = DOCK.icon * mag;
        const running = i === 0 || (i === DOCK.gyro && gyroRunning);
        return (
          <React.Fragment key={i}>
            <div style={{ position: "absolute", left: cx - size / 2, top: DOCK.y + DOCK.icon / 2 - size - 2 - hop, width: size, height: size }}>
              {icon ?? <Img src={staticFile("gyro-app-icon.png")} style={{ position: "absolute", left: "-12%", top: "-12%", width: "124%", height: "124%" }} />}
            </div>
            {running && <div style={{ position: "absolute", left: cx - 2, top: DOCK.y + 35, width: 4, height: 4, borderRadius: 2, background: "rgba(20,24,40,0.7)" }} />}
          </React.Fragment>
        );
      })}
    </>
  );
};

export const MenuBar: React.FC<{ clock: React.ReactNode; dark?: number }> = ({ clock, dark = 0 }) => {
  const ink = dark > 0.5 ? "#fff" : "#111";
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 30, display: "flex", alignItems: "center", padding: "0 18px", gap: 22, background: `rgba(${dark > 0.5 ? "20,24,50,0.35" : "255,255,255,0.4"})`, backdropFilter: "blur(20px)", fontFamily: text, fontSize: 14, color: ink }}>
      <span style={{ fontWeight: 700 }}>Gyro</span>
      {["File", "Edit", "View", "Window", "Help"].map((m) => <span key={m} style={{ fontWeight: 500 }}>{m}</span>)}
      <span style={{ flex: 1 }} />
      <svg width="17" height="13" viewBox="0 0 17 13" fill={ink}><path d="M8.5 12.5 6 9.8a3.6 3.6 0 0 1 5 0Z" /><path d="M3.6 7.4a7 7 0 0 1 9.8 0l-1.3 1.3a5.2 5.2 0 0 0-7.2 0Z" /><path d="M1.2 5A10.4 10.4 0 0 1 15.8 5l-1.3 1.3a8.6 8.6 0 0 0-12 0Z" /></svg>
      <svg width="26" height="12" viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke={ink} opacity=".5" /><rect x="2" y="2" width="16" height="8" rx="1.6" fill={ink} /><rect x="23.5" y="4" width="1.6" height="4" rx=".8" fill={ink} opacity=".5" /></svg>
      <span style={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{clock}</span>
    </div>
  );
};

/** Desktop: wallpaper, the window (children), menu bar, dock. `night` 0..1 darkens it all. */
export const Desktop: React.FC<{ clock: React.ReactNode; children?: React.ReactNode; hoverX?: number; bounceAt?: number; gyroRunning?: boolean; night?: number; morning?: number }> = ({
  clock, children, hoverX, bounceAt, gyroRunning, night = 0, morning = 0,
}) => (
  <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, overflow: "hidden" }}>
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(1200px 800px at 18% 12%, #D9E0FB 0%, rgba(217,224,251,0) 60%), radial-gradient(1000px 700px at 88% 30%, #F8E1D6 0%, rgba(248,225,214,0) 60%), radial-gradient(1400px 900px at 50% 110%, #C7D0F4 0%, rgba(199,208,244,0) 60%), #ECEEF7",
      }}
    />
    {children}
    <Dock hoverX={hoverX} bounceAt={bounceAt} gyroRunning={gyroRunning} />
    {night > 0 && <AbsoluteFill style={{ background: "linear-gradient(180deg,#0B1030,#151A45)", opacity: night * 0.72, mixBlendMode: "multiply" }} />}
    {morning > 0 && <AbsoluteFill style={{ background: "radial-gradient(1400px 900px at 85% 0%, rgba(255,196,140,0.55), rgba(255,196,140,0) 70%)", opacity: morning, mixBlendMode: "soft-light" }} />}
    <MenuBar clock={clock} dark={night} />
  </div>
);

/** The real app window on the desktop at WIN. */
export const Window: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ position: "absolute", left: WIN.x, top: WIN.y, width: 1280, height: 800, transformOrigin: "0 0", transform: `scale(${WIN.s})`, borderRadius: 14, boxShadow: "0 0 0 1px rgba(16,20,42,0.10), 0 30px 80px -20px rgba(16,20,42,0.45)", ...style }}>{children}</div>
);

/** Horizontal stripes covering (p 0→1) the frame, alternating from left and right. */
export const Stripes: React.FC<{ p: number; dir?: 1 | -1 }> = ({ p, dir = 1 }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    {Array.from({ length: 9 }, (_, i) => {
      const k = Math.max(0, Math.min(1, p * 1.6 - i * 0.075));
      const fromLeft = (i % 2 === 0) === (dir === 1);
      return <div key={i} style={{ position: "absolute", top: i * 120, height: 121, width: 1920 * k, [fromLeft ? "left" : "right"]: 0, background: i % 3 === 1 ? "#2F9E62" : C.green }} />;
    })}
  </AbsoluteFill>
);
