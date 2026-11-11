import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Words, clamp, type Word } from "./motion";
import { C, display, inOut, mono, out, prog, text } from "./theme";

/**
 * usegyro.io look: a pale lavender page, a soft indigo-to-coral "needle" blade
 * swinging over a dial of ticks, white pills and black pill buttons.
 */

export const SiteBg: React.FC<{ wash?: number }> = ({ wash = 1 }) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.canvas,
      backgroundImage: [
        `radial-gradient(1500px 760px at 50% -8%, rgba(236,238,251,${wash}), rgba(236,238,251,0) 70%)`,
        `radial-gradient(900px 520px at 88% 0%, rgba(170,184,255,${0.16 * wash}), transparent 70%)`,
      ].join(", "),
    }}
  />
);

/** Conic blade from a pivot, pointing at `angle` (0 = up, clockwise). */
export const Needle: React.FC<{
  cx: number;
  cy: number;
  angle: number;
  reach?: number;
  opacity?: number;
  edge?: number;
  blur?: number;
}> = ({ cx, cy, angle, reach = 1400, opacity = 1, edge = 1, blur = 28 }) => {
  // The site's blade spans 14°→36°, brightest around 30°: aim that core at `angle`.
  const from = angle - 30;
  const rad = ((angle - 90) * Math.PI) / 180;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          opacity,
          filter: `blur(${blur}px)`,
          backgroundImage: `conic-gradient(from ${from}deg at ${cx}px ${cy}px, transparent 14deg, rgba(170,184,255,.22) 19deg, rgba(96,118,245,.36) 24deg, rgba(66,92,235,.68) 28.5deg, rgba(255,128,96,.7) 31.5deg, rgba(255,196,170,.6) 33deg, transparent 36deg)`,
          WebkitMaskImage: `radial-gradient(${reach}px ${reach}px at ${cx}px ${cy}px, #000 0%, #000 55%, transparent 100%)`,
          maskImage: `radial-gradient(${reach}px ${reach}px at ${cx}px ${cy}px, #000 0%, #000 55%, transparent 100%)`,
        }}
      />
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, overflow: "visible", opacity: opacity * edge }}>
        <defs>
          <linearGradient id={`ne${Math.round(cx)}${Math.round(cy)}`} x1={cx} y1={cy} x2={cx + Math.cos(rad) * reach} y2={cy + Math.sin(rad) * reach} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.35" stopColor="#fff" stopOpacity="0.95" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1={cx}
          y1={cy}
          x2={cx + Math.cos(rad) * reach}
          y2={cy + Math.sin(rad) * reach}
          stroke={`url(#ne${Math.round(cx)}${Math.round(cy)})`}
          strokeWidth={2.5}
        />
      </svg>
    </AbsoluteFill>
  );
};

/** Arc of dial ticks around a pivot; every fifth tick is long. `draw` reveals them in order. */
export const Dial: React.FC<{
  cx: number;
  cy: number;
  r: number;
  from: number;
  to: number;
  count: number;
  draw?: number;
  color?: string;
  active?: number;
}> = ({ cx, cy, r, from, to, count, draw = 1, color = "rgba(16,20,42,0.22)", active }) => (
  <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
    {Array.from({ length: count }).map((_, i) => {
      const t = i / (count - 1);
      const a = from + (to - from) * t;
      const vis = interpolate(draw, [t * 0.85, t * 0.85 + 0.15], [0, 1], clamp);
      if (vis <= 0) return null;
      const rad = ((a - 90) * Math.PI) / 180;
      const long = i % 5 === 0;
      const len = long ? 34 : 16;
      const near = active === undefined ? 0 : Math.max(0, 1 - Math.abs(a - active) / 6);
      return (
        <line
          key={i}
          x1={cx + Math.cos(rad) * r}
          y1={cy + Math.sin(rad) * r}
          x2={cx + Math.cos(rad) * (r + len * vis)}
          y2={cy + Math.sin(rad) * (r + len * vis)}
          stroke={near > 0 ? `rgba(66,92,235,${0.3 + 0.7 * near})` : color}
          strokeWidth={long ? 3 : 2}
          strokeLinecap="round"
          opacity={vis}
        />
      );
    })}
  </svg>
);

/** White pill with a dot, like the site's release badge. */
export const Badge: React.FC<{ children: React.ReactNode; dot?: string; size?: number; style?: React.CSSProperties }> = ({
  children,
  dot = C.coral,
  size = 30,
  style,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.5,
      padding: `${size * 0.45}px ${size * 0.95}px`,
      borderRadius: 999,
      background: "#fff",
      border: `1.5px solid ${C.line}`,
      boxShadow: "0 1px 2px rgba(23,23,20,0.04), 0 10px 30px -14px rgba(23,23,20,0.12)",
      fontFamily: text,
      fontSize: size,
      fontWeight: 500,
      color: C.ink,
      letterSpacing: -size * 0.01,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    <span style={{ width: size * 0.36, height: size * 0.36, borderRadius: 99, background: dot, boxShadow: `0 0 0 ${size * 0.18}px ${dot}22` }} />
    {children}
  </div>
);

/** Black pill button, like "Download for macOS". */
export const BlackPill: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 40, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.4,
      padding: `${size * 0.55}px ${size * 1.2}px`,
      borderRadius: 999,
      background: C.ink,
      color: "#fff",
      fontFamily: text,
      fontWeight: 500,
      fontSize: size,
      letterSpacing: -size * 0.02,
      boxShadow: "0 1px 0 rgba(255,255,255,0.12) inset, 0 20px 40px -18px rgba(16,20,42,0.55)",
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </div>
);

export const WhitePill: React.FC<{ children: React.ReactNode; size?: number; style?: React.CSSProperties }> = ({ children, size = 30, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: `${size * 0.6}px ${size * 1.1}px`,
      borderRadius: 999,
      background: "#fff",
      border: `1.5px solid ${C.line}`,
      fontFamily: mono,
      fontSize: size,
      color: C.ink,
      whiteSpace: "nowrap",
      boxShadow: "0 10px 30px -16px rgba(23,23,20,0.14)",
      ...style,
    }}
  >
    {children}
  </div>
);

/** Soft white card in the site style. */
export const siteCard: React.CSSProperties = {
  background: "#fff",
  borderRadius: 32,
  border: `1.5px solid ${C.line}`,
  boxShadow: "0 1px 2px rgba(23,23,20,0.035), 0 30px 70px -30px rgba(23,23,20,0.16)",
};

/** Section ticks on the right edge, like the site's scroll rail. */
export const SectionTicks: React.FC<{ active: number; count?: number }> = ({ active, count = 5 }) => {
  const frame = useCurrentFrame();
  const a = prog(frame, 6, 26, out);
  return (
    <div style={{ position: "absolute", right: 54, top: 540, translate: "0 -50%", display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-end", opacity: a }}>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          style={{
            height: 3,
            borderRadius: 3,
            width: i === active ? 44 * a : 18,
            background: i === active ? C.blue : "rgba(16,20,42,0.18)",
          }}
        />
      ))}
    </div>
  );
};

/**
 * One idea per beat: a badge, a big plain headline and one short line, all
 * held on screen the whole time, then handed off upwards at `exit`.
 */
export const Title: React.FC<{
  kicker: string;
  dot?: string;
  words: Word[];
  sub?: string;
  at?: number;
  exit: number;
  top?: number;
  size?: number;
}> = ({ kicker, dot, words, sub, at = 4, exit, top = 110, size = 104 }) => {
  const frame = useCurrentFrame();
  const k = prog(frame, at, at + 18, out);
  const s = prog(frame, at + 16, at + 36, out);
  const gone = prog(frame, exit, exit + 14, inOut);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
      <div style={{ opacity: k * (1 - gone), translate: `0 ${(1 - k) * 14 - gone * 30}px`, filter: k < 0.99 ? `blur(${(1 - k) * 8}px)` : undefined }}>
        <Badge dot={dot} size={26}>
          {kicker}
        </Badge>
      </div>
      <Words words={words} at={at + 6} stagger={5} len={18} size={size} out={exit} />
      {sub && (
        <div
          style={{
            fontFamily: display,
            fontSize: 40,
            fontWeight: 450,
            letterSpacing: -0.8,
            color: C.muted,
            opacity: s * (1 - gone),
            translate: `0 ${(1 - s) * 16 - gone * 30}px`,
            filter: s < 0.99 || gone > 0.01 ? `blur(${(1 - s) * 8 + gone * 8}px)` : undefined,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
};

/** The demo area under a Title: rises in, then softly leaves with the title. */
export const Stage: React.FC<{ at: number; exit: number; children: React.ReactNode }> = ({ at, exit, children }) => {
  const frame = useCurrentFrame();
  const a = prog(frame, at, at + 24, out);
  const g = prog(frame, exit, exit + 16, inOut);
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(1, a * 1.4) * (1 - g),
        translate: `0 ${(1 - a) * 60 - g * 40}px`,
        scale: 0.97 + 0.03 * a - 0.02 * g,
        filter: a < 0.99 || g > 0.01 ? `blur(${(1 - a) * 14 + g * 12}px)` : undefined,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export { display, mono, text };
