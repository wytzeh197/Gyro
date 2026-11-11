import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, interpolate, interpolateColors, useCurrentFrame } from "remotion";
import { Odometer, clamp } from "./motion";
import { C, display, inOut, out, prog, text } from "./theme";

/**
 * Text-led storytelling, the way the reference film does it: a sentence is
 * built word by word in the middle of the frame, every new word pushes the
 * line open so it re-centres itself, and small pieces of UI sit inline as
 * words of their own.
 */

let ctx: CanvasRenderingContext2D | null = null;
let fontsReady = false;

/**
 * Canvas measuring only sees a web font once it has loaded, so hold the frame
 * until Geist is in, then re-render with true widths.
 */
export const useFontsReady = () => {
  const [ready, setReady] = useState(fontsReady);
  useEffect(() => {
    if (ready) return;
    const h = delayRender("kinetic fonts");
    Promise.all(
      ["400 40px 'Geist'", "450 40px 'Geist'", "500 40px 'Geist'", "560 40px 'Geist'", "400 40px 'Geist Mono'"].map((f) => document.fonts.load(f)),
    )
      .then(() => document.fonts.ready)
      .then(() => {
        fontsReady = true;
        setReady(true);
        continueRender(h);
      });
  }, [ready]);
  return ready;
};

/** Width of a run of text in the film's display face, measured on a canvas. */
export const measure = (s: string, size: number, weight = 560, family = display, spacing = -size * 0.045) => {
  if (typeof document === "undefined") return s.length * size * 0.52;
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return s.length * size * 0.52;
  ctx.font = `${weight} ${size}px ${family}`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
  return ctx.measureText(s).width;
};

type TextTok = { t: string; color?: string; weight?: number; after?: number };
type ElTok = { el: React.ReactNode | ((start: number) => React.ReactNode); w: number | ((frame: number) => number); after?: number };
export type Tok = string | TextTok | ElTok;

/**
 * A sentence on its own lines. Tokens arrive one after another (`stagger`
 * frames apart, plus any `after` pause); with `grow` each one opens its own
 * space so the line slides to stay centred. `out` sends it away word by word.
 */
export const Say: React.FC<{
  lines: Tok[][];
  at: number;
  out?: number;
  stagger?: number;
  len?: number;
  size?: number;
  color?: string;
  weight?: number;
  grow?: boolean;
  y?: number;
  lineGap?: number;
}> = ({ lines, at, out: outAt, stagger = 5, len = 16, size = 100, color = C.ink, weight = 560, grow = true, y = 0, lineGap = 0.16 }) => {
  const frame = useCurrentFrame();
  useFontsReady();
  const sp = size * 0.26;
  const lineH = size * (1 + lineGap);
  let t = at;
  let idx = 0;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", translate: `0 ${y}px` }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", fontFamily: display, fontSize: size, fontWeight: weight, letterSpacing: -size * 0.045, color }}>
        {lines.map((line, li) => (
          <div key={li} style={{ display: "flex", justifyContent: "center", alignItems: "center", height: lineH }}>
            {line.map((tok, ti) => {
              const o: TextTok | ElTok = typeof tok === "string" ? { t: tok } : tok;
              t += o.after ?? 0;
              const s = t;
              t += stagger;
              const i = idx++;
              const p = prog(frame, s, s + len, out);
              const g = grow ? prog(frame, s - 8, s + 6, inOut) : 1;
              const isEl = "el" in o;
              const w0 = isEl ? (typeof o.w === "function" ? o.w(frame) : o.w) : measure(o.t, size, o.weight ?? weight);
              const lead = ti > 0 ? sp : 0;
              let opacity = p;
              let blur = (1 - p) * size * 0.14;
              let ty = (1 - p) * size * 0.34;
              if (outAt !== undefined) {
                const q = prog(frame, outAt + i * 2, outAt + i * 2 + 13, inOut);
                opacity *= 1 - q;
                blur += q * size * 0.14;
                ty -= q * size * 0.42;
              }
              return (
                <span key={ti} style={{ position: "relative", display: "inline-block", flexShrink: 0, width: (w0 + lead) * g, height: lineH }}>
                  <span
                    style={{
                      position: "absolute",
                      left: lead,
                      top: 0,
                      height: lineH,
                      display: "flex",
                      alignItems: "center",
                      whiteSpace: "pre",
                      lineHeight: 1,
                      opacity,
                      filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
                      translate: `0 ${ty}px`,
                      color: isEl ? undefined : o.color,
                      fontWeight: isEl ? undefined : o.weight,
                    }}
                  >
                    {isEl ? (typeof o.el === "function" ? o.el(s) : o.el) : o.t}
                  </span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Frame at which the n-th token of a sentence starts, for timing extras against it. */
export const tokAt = (at: number, n: number, stagger = 5) => at + n * stagger;

/** A word that arrives soft and grey, then snaps into focus. */
export const Sharpen: React.FC<{ t: string; at: number; to?: string; from?: string }> = ({ t, at, to = C.blue, from = "#B9BCCB" }) => {
  const frame = useCurrentFrame();
  const p = prog(frame, at, at + 18, inOut);
  return (
    <span style={{ color: interpolateColors(p, [0, 1], [from, to]), filter: p < 0.99 ? `blur(${(1 - p) * 9}px)` : undefined, scale: 0.96 + 0.04 * p }}>
      {t}
    </span>
  );
};

/** Inline rolling number. Pair with `odoWidth` so the line opens exactly as wide as the digits. */
export const InlineOdo: React.FC<{ from: number; to: number; at: number; len: number; digits: number; size: number; color?: string }> = ({
  from,
  to,
  at,
  len,
  digits,
  size,
  color = C.ink,
}) => {
  const frame = useCurrentFrame();
  const v = valueAt(frame, from, to, at, len);
  const pv = valueAt(frame - 1, from, to, at, len);
  return <Odometer value={v} prev={pv} digits={digits} size={size} weight={560} color={color} />;
};

const valueAt = (frame: number, from: number, to: number, at: number, len: number) =>
  interpolate(frame, [at, at + len], [from, to], { ...clamp, easing: inOut });

/** Mirrors Odometer's layout: visible digit columns plus their thousands commas. */
export const odoWidth = (v: number, digits: number, size: number) => {
  const w = size * 0.6;
  let total = 0;
  for (let p = digits - 1; p >= 0; p--) {
    const place = Math.pow(10, p);
    const vis = p === 0 ? 1 : interpolate(Math.max(0, v) / place, [0.9, 1], [0, 1], clamp);
    total += w * vis;
    if (p > 0 && p % 3 === 0 && vis > 0) total += size * 0.26 * vis;
  }
  return total;
};

export const odoTok = (o: { from: number; to: number; at: number; len: number; digits: number; size: number; color?: string; after?: number }): ElTok => ({
  after: o.after,
  w: (f) => odoWidth(valueAt(f, o.from, o.to, o.at, o.len), o.digits, o.size),
  el: <InlineOdo {...o} />,
});

/** White pill with a coloured dot, used inline for providers. */
export const pillW = (name: string, size = 36) => measure(name, size, 500, text, -size * 0.01) + size * 2.4;
export const Pill: React.FC<{ name: string; dot: string; size?: number }> = ({ name, dot, size = 36 }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.4,
      height: size * 2.1,
      width: pillW(name, size),
      boxSizing: "border-box",
      padding: `0 ${size * 0.8}px`,
      borderRadius: 999,
      background: "#fff",
      border: `1.5px solid ${C.line}`,
      boxShadow: "0 14px 30px -18px rgba(16,20,42,0.28)",
      fontFamily: text,
      fontWeight: 500,
      fontSize: size,
      letterSpacing: -size * 0.01,
      color: C.ink,
      whiteSpace: "nowrap",
    }}
  >
    <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: 99, background: dot, flexShrink: 0 }} />
    {name}
  </span>
);

/** Rounded square icon tile, used inline like an app icon. */
export const Tile: React.FC<{ size: number; bg?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ size, bg = C.blueSoft, children, style }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: size,
      height: size,
      borderRadius: size * 0.28,
      background: bg,
      boxShadow: "0 1px 0 rgba(255,255,255,0.6) inset, 0 16px 30px -16px rgba(16,20,42,0.35)",
      ...style,
    }}
  >
    {children}
  </span>
);
