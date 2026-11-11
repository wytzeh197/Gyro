import React from "react";
import { useCurrentFrame } from "remotion";
import { C, out, prog, text } from "./theme";

/**
 * Stage pieces for the camera-driven beats: a site-style app window, a block
 * that places a centred `Say` anywhere on the big stage, placeholder code
 * bars, and a curved link with a travelling pulse.
 */

/** Places a 1920 × 1080 region on the stage, so a centred `Say` lands there. */
export const Region: React.FC<{ x?: number; y?: number; children: React.ReactNode }> = ({ x = 0, y = 0, children }) => (
  <div style={{ position: "absolute", left: x, top: y, width: 1920, height: 1080 }}>{children}</div>
);

/** A white app window in the site style, or a near-black one with `dark`. */
export const Win: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  dark?: boolean;
  at?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ x, y, w, h, title, dark, at, style, children }) => {
  const frame = useCurrentFrame();
  const p = at === undefined ? 1 : prog(frame, at, at + 22, out);
  const bar = 54;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 28,
        overflow: "hidden",
        background: dark ? "#141416" : "#fff",
        border: `1.5px solid ${dark ? "#2C2C31" : C.line}`,
        boxShadow: "0 1px 2px rgba(16,20,42,0.05), 0 40px 90px -36px rgba(16,20,42,0.38)",
        opacity: Math.min(1, p * 1.5),
        scale: 1.06 - 0.06 * p,
        filter: p < 0.99 ? `blur(${(1 - p) * 18}px)` : undefined,
        ...style,
      }}
    >
      <div
        style={{
          height: bar,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 22px",
          borderBottom: `1.5px solid ${dark ? "#26262B" : C.line}`,
          background: dark ? "#1A1A1D" : "#FAFAFC",
          position: "relative",
        }}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 14, height: 14, borderRadius: 99, background: dark ? "#34343A" : "#DEDFE6" }} />
        ))}
        {title && (
          <span
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              textAlign: "center",
              fontFamily: text,
              fontSize: 22,
              fontWeight: 500,
              color: dark ? "#8D8D96" : C.muted,
            }}
          >
            {title}
          </span>
        )}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: bar, bottom: 0 }}>{children}</div>
    </div>
  );
};

/** Placeholder lines of code or prose. */
export const Bars: React.FC<{ widths: number[]; color?: string; h?: number; gap?: number; at?: number; style?: React.CSSProperties }> = ({
  widths,
  color = "#E6E7EE",
  h = 14,
  gap = 18,
  at,
  style,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap, ...style }}>
      {widths.map((w, i) => {
        const p = at === undefined ? 1 : prog(frame, at + i * 2, at + i * 2 + 14);
        return <span key={i} style={{ width: w * p, height: h, borderRadius: h, background: color }} />;
      })}
    </div>
  );
};

type P = [number, number];
const cubic = (a: P, b: P, c: P, d: P, t: number): P => {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
};

/** A curved connector that draws itself, then carries a pulse along. */
export const Link: React.FC<{ a: P; d: P; at: number; len?: number; color?: string; speed?: number }> = ({
  a,
  d,
  at,
  len = 18,
  color = C.blue,
  speed = 40,
}) => {
  const frame = useCurrentFrame();
  const draw = prog(frame, at, at + len);
  const mx = (a[0] + d[0]) / 2;
  const b: P = [mx, a[1]];
  const c: P = [mx, d[1]];
  const path = `M${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;
  const t = ((frame - at - len) / speed) % 1;
  const dot = cubic(a, b, c, d, t < 0 ? 0 : t);
  return (
    <g>
      <path d={path} fill="none" stroke="#C9CEE8" strokeWidth={3} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
      {draw > 0.98 && <circle cx={dot[0]} cy={dot[1]} r={7} fill={color} style={{ filter: `drop-shadow(0 0 8px ${color})` }} />}
    </g>
  );
};
