// Calm, UI-led primitives: word builds, pointer, selection, keycaps, morphs.
// Every entrance is opacity + blur + small rise; every exit is blur + fade.
import { useFrame } from "../pace";
import React from "react";
import { AbsoluteFill, Easing, interpolate, interpolateColors, random } from "remotion";
import { C, inOut, mono } from "./theme";
import { clamp } from "./motion";

export const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
export const line = "'Inter Tight', 'Geist', system-ui, sans-serif";
export const INK_BG = C.ink;

const p01 = (f: number, a: number, b: number, e = ease) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: e });

/** Blur + fade exit (8f by default). Returns style for an element leaving at `at`. */
export const blurOut = (f: number, at?: number, len = 8): React.CSSProperties => {
  if (at === undefined || f < at) return {};
  const t = p01(f, at, at + len, inOut);
  return { opacity: 1 - t, filter: `blur(${t * 16}px)` };
};

/** Blur + rise entrance. */
export const blurIn = (f: number, at: number, len = 10, blur = 12, rise = 14): React.CSSProperties => {
  const t = p01(f, at, at + len);
  return { opacity: t, filter: t < 1 ? `blur(${(1 - t) * blur}px)` : undefined, translate: `0px ${(1 - t) * rise}px` };
};

// ---- Word build ------------------------------------------------------------
let ctx: CanvasRenderingContext2D | null = null;
const measure = (s: string, size: number, weight: number, family: string) => {
  if (typeof document === "undefined") return s.length * size * 0.5;
  ctx = ctx ?? document.createElement("canvas").getContext("2d");
  if (!ctx) return s.length * size * 0.5;
  ctx.font = `${weight} ${size}px ${family}`;
  return ctx.measureText(s).width - size * 0.03 * s.length; // tracking −0.03em
};

/**
 * A centred line that builds word by word and re-centres as it grows.
 * - newest word lands blue, then eases to `color`
 * - `firstFrom` opens on a huge first word that shrinks into the line
 * - `keyword` + `keyAt` blurs the others away and centres the keyword
 * - `trail` keeps a block cursor after the last visible word
 */
export const WordBuild: React.FC<{
  words: string[];
  at: number;
  size?: number;
  stagger?: number;
  color?: string;
  accent?: string;
  weight?: number;
  firstFrom?: number;
  keyword?: number;
  keyAt?: number;
  until?: number;
  trail?: boolean;
  /** Word index painted coral for good (once in the film). */
  coral?: number;
  y?: number;
  style?: React.CSSProperties;
}> = ({ words, at, size = 88, stagger = 5, color = C.ink, accent = C.blue, weight = 500, firstFrom, keyword, keyAt, until, trail, coral, y = 540, style }) => {
  const f = useFrame();
  const space = size * 0.26;
  const shrink = firstFrom ? 18 : 0;
  const starts = words.map((_, i) => (i === 0 ? at : at + shrink + i * stagger));
  const widths = words.map((w) => measure(w, size, weight, line));
  const items = words.map((w, i) => {
    const a = starts[i];
    const enter = i === 0 && firstFrom ? p01(f, a, a + 6) : p01(f, a, a + 9);
    let scale = 1;
    if (i === 0 && firstFrom) scale = interpolate(p01(f, a + 4, a + 4 + shrink, inOut), [0, 1], [firstFrom / size, 1]);
    const gone = keyword !== undefined && keyAt !== undefined && i !== keyword ? p01(f, keyAt, keyAt + 10, inOut) : 0;
    const share = (i === 0 && firstFrom ? (f >= a ? 1 : 0) : p01(f, a, a + 10, inOut)) * (1 - gone);
    const col = i === coral ? C.coral : interpolateColors(f, [a + 6, a + 14], [accent, color]);
    return { w, i, enter, scale, gone, share, col };
  });
  const total = items.reduce((s, it) => s + (widths[it.i] * it.scale + space) * it.share, 0) - space * (items.some((it) => it.share > 0) ? 1 : 0);
  let x = -total / 2;
  const last = items.reduce((k, it) => (it.share > 0.01 ? it.i : k), -1);
  let trailX = 0;
  const placed = items.map((it) => {
    const left = x;
    x += (widths[it.i] * it.scale + space) * it.share;
    if (it.i === last) trailX = left + widths[it.i] * it.scale + space * 0.5;
    return { ...it, left };
  });
  return (
    <AbsoluteFill style={{ pointerEvents: "none", ...blurOut(f, until), ...style }}>
      {placed.map((it) => {
        const rise = (1 - it.enter) * 14;
        const blur = (1 - it.enter) * 12 + it.gone * 14;
        return (
          <div
            key={it.i}
            style={{
              position: "absolute",
              left: 960 + it.left,
              top: y,
              width: widths[it.i],
              transformOrigin: "0 50%",
              transform: `translateY(-50%) translateY(${rise}px) scale(${it.scale})`,
              fontFamily: line,
              fontWeight: weight,
              fontSize: size,
              letterSpacing: "-0.03em",
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: it.col,
              opacity: it.enter * (1 - it.gone),
              filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
            }}
          >
            {it.w}
          </div>
        );
      })}
      {trail && last >= 0 && (
        <Block h={size * 0.86} at={at} style={{ position: "absolute", left: 960 + trailX, top: y, transform: "translateY(-50%)" }} />
      )}
    </AbsoluteFill>
  );
};

/** Block cursor, blinking on a 15f cycle. */
export const Block: React.FC<{ h: number; at?: number; color?: string; solid?: boolean; style?: React.CSSProperties }> = ({ h, at = 0, color = C.blue, solid, style }) => {
  const f = useFrame();
  const on = solid || Math.floor((f - at) / 15) % 2 === 0;
  return <div style={{ width: h * 0.5, height: h, borderRadius: h * 0.06, background: color, opacity: f < at ? 0 : on ? 1 : 0, ...style }} />;
};

// ---- Decode / mono label ---------------------------------------------------
const GLYPHS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789/#·";
/** Mono text resolving from random glyphs, left to right, over `len` frames. */
export const Decode: React.FC<{ text: string; at: number; len?: number; style?: React.CSSProperties }> = ({ text, at, len = 12, style }) => {
  const f = useFrame();
  if (f < at) return null;
  const done = Math.floor(p01(f, at, at + len, (t) => t) * text.length);
  const s = text
    .split("")
    .map((ch, i) => (i < done || ch === " " ? ch : GLYPHS[Math.floor(random(`${text}${i}${Math.floor(f / 2)}`) * GLYPHS.length)]))
    .join("");
  return <span style={{ fontFamily: mono, whiteSpace: "pre", ...style }}>{s}</span>;
};

export const MonoLabel: React.FC<{ text: string; at: number; x: number; y: number; color?: string; bg?: string; size?: number; until?: number }> = ({ text, at, x, y, color = C.blue, bg = C.blueSoft, size = 22, until }) => {
  const f = useFrame();
  return (
    <div style={{ position: "absolute", left: x, top: y, ...blurIn(f, at, 8, 8, 6), ...blurOut(f, until), padding: `${size * 0.3}px ${size * 0.55}px`, borderRadius: size * 0.3, background: bg, color, fontSize: size, fontWeight: 500, letterSpacing: "0.02em" }}>
      <Decode text={text} at={at} />
    </div>
  );
};

// ---- Rotator ---------------------------------------------------------------
/** One slot cycling through items: out up with blur, in from below. */
export const Rotator: React.FC<{ items: string[]; at: number; every?: number; style?: React.CSSProperties; height: number; hold?: boolean }> = ({ items, at, every = 12, style, height }) => {
  const f = useFrame();
  const t = f - at;
  const i = Math.max(0, Math.min(items.length - 1, Math.floor(t / every)));
  const local = t - i * every;
  const inP = i === 0 ? p01(t, 0, 8) : p01(local, 0, 8);
  const prev = i > 0 && local < 8 ? items[i - 1] : null;
  return (
    <span style={{ position: "relative", display: "inline-block", height, verticalAlign: "top", ...style }}>
      {prev && (
        <span style={{ position: "absolute", left: 0, top: 0, whiteSpace: "nowrap", opacity: 1 - inP, translate: `0px ${-inP * height * 0.5}px`, filter: `blur(${inP * 12}px)` }}>{prev}</span>
      )}
      <span style={{ display: "inline-block", whiteSpace: "nowrap", opacity: f < at ? 0 : inP, translate: `0px ${(1 - inP) * height * 0.5}px`, filter: inP < 1 ? `blur(${(1 - inP) * 12}px)` : undefined }}>{items[i]}</span>
    </span>
  );
};

// ---- Overlays --------------------------------------------------------------
/** Arrow pointer moving between [frame, x, y] keys; dips to 0.92 for 4f on each click. */
export const Pointer: React.FC<{ keys: [number, number, number][]; clicks?: number[]; at?: number; until?: number; size?: number }> = ({ keys, clicks = [], at = keys[0][0], until, size = 34 }) => {
  const f = useFrame();
  if (f < at - 8) return null;
  const fs = keys.map((k) => k[0]);
  const x = keys.length > 1 ? interpolate(f, fs, keys.map((k) => k[1]), { ...clamp, easing: inOut }) : keys[0][1];
  const y = keys.length > 1 ? interpolate(f, fs, keys.map((k) => k[2]), { ...clamp, easing: inOut }) : keys[0][2];
  const dip = clicks.some((c) => f >= c && f < c + 4) ? 0.92 : 1;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: size, height: size * 1.3, transformOrigin: "0 0", transform: `scale(${dip})`, ...blurIn(f, at - 8, 8, 6, 0), ...blurOut(f, until), filter: "drop-shadow(0 3px 6px rgba(16,20,42,0.3))" }}>
      <svg viewBox="0 0 24 31" width="100%" height="100%">
        <path d="M1.5 1.5 L1.5 25 L7.6 19.4 L11.6 28.8 L15.6 27.1 L11.7 18 L19.8 18 Z" fill={C.ink} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
      {clicks.map((c) => {
        const r = p01(f, c, c + 14);
        return f >= c && r < 1 ? (
          <div key={c} style={{ position: "absolute", left: -size * 0.9 * r, top: -size * 0.9 * r, width: size * 1.8 * r, height: size * 1.8 * r, borderRadius: "50%", border: `2px solid ${C.blue}`, opacity: 1 - r }} />
        ) : null;
      })}
    </div>
  );
};

/** Selection rectangle with corner handles and a mono label tab. */
export const SelectionBox: React.FC<{ x: number; y: number; w: number; h: number; at: number; until?: number; label?: string; color?: string }> = ({ x, y, w, h, at, until, label, color = C.blue }) => {
  const f = useFrame();
  const t = p01(f, at, at + 12, inOut);
  if (f < at) return null;
  const ww = w * (0.94 + 0.06 * t);
  const hh = h * (0.94 + 0.06 * t);
  const hs = 10;
  return (
    <div style={{ position: "absolute", left: x + (w - ww) / 2, top: y + (h - hh) / 2, width: ww, height: hh, border: `2px solid ${color}`, borderRadius: 6, opacity: t, ...blurOut(f, until) }}>
      {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => (
        <div key={`${a}${b}`} style={{ position: "absolute", left: a ? ww - hs / 2 - 2 : -hs / 2 - 1, top: b ? hh - hs / 2 - 2 : -hs / 2 - 1, width: hs, height: hs, background: "#fff", border: `2px solid ${color}`, borderRadius: 2 }} />
      ))}
      {label && (
        <div style={{ position: "absolute", left: -2, top: -38, padding: "5px 10px", borderRadius: 5, background: color, color: "#fff", fontSize: 18, fontWeight: 500 }}>
          <Decode text={label} at={at + 2} len={10} />
        </div>
      )}
    </div>
  );
};

/** Hand-drawn loop around a box, drawn by dash offset over 18f. */
export const HandCircle: React.FC<{ x: number; y: number; w: number; h: number; at: number; until?: number; color?: string; stroke?: number }> = ({ x, y, w, h, at, until, color = C.blue, stroke = 5 }) => {
  const f = useFrame();
  const t = p01(f, at, at + 18, inOut);
  const cx = w / 2;
  const cy = h / 2;
  // Slightly uneven loop that overshoots its start, like a pen.
  const d = `M ${cx - w * 0.08} ${-h * 0.02} C ${w * 1.02} ${-h * 0.12}, ${w * 1.1} ${h * 0.95}, ${cx} ${h * 1.04} C ${-w * 0.1} ${h * 1.08}, ${-w * 0.08} ${h * 0.02}, ${cx + w * 0.12} ${-h * 0.06}`;
  const len = (w + h) * 2.4;
  if (f < at) return null;
  return (
    <svg style={{ position: "absolute", left: x, top: y, overflow: "visible", ...blurOut(f, until) }} width={w} height={h}>
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - t)} />
    </svg>
  );
};

/** ⌘K-style keycaps; `press` sinks them for 4f. */
export const Keycap: React.FC<{ keys: string[]; at: number; press?: number; until?: number; x: number; y: number; size?: number }> = ({ keys, at, press, until, x, y, size = 64 }) => {
  const f = useFrame();
  const down = press !== undefined && f >= press && f < press + 5;
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: "translate(-50%, -50%)", display: "flex", gap: size * 0.18, ...blurIn(f, at, 10, 10, 10), ...blurOut(f, until) }}>
      {keys.map((k) => (
        <div
          key={k}
          style={{
            minWidth: size,
            height: size,
            padding: `0 ${size * 0.22}px`,
            boxSizing: "border-box",
            borderRadius: size * 0.22,
            background: "#fff",
            border: `1px solid ${C.line}`,
            boxShadow: down ? `0 1px 0 ${C.line}` : `0 ${size * 0.07}px 0 #D9DBE6, 0 12px 28px -10px rgba(16,20,42,0.25)`,
            translate: down ? `0px ${size * 0.06}px` : undefined,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: line,
            fontWeight: 500,
            fontSize: size * 0.46,
            color: down ? C.blue : C.ink,
          }}
        >
          {k}
        </div>
      ))}
    </div>
  );
};

/** Soft blue bloom that swells at `at` and settles. */
export const Glow: React.FC<{ x: number; y: number; at: number; r?: number; peak?: number; len?: number }> = ({ x, y, at, r = 420, peak = 0.55, len = 30 }) => {
  const f = useFrame();
  if (f < at) return null;
  const up = p01(f, at, at + 8);
  const down = p01(f, at + 8, at + len, inOut);
  const o = peak * up * (1 - down);
  return (
    <div style={{ position: "absolute", left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: "50%", background: `radial-gradient(closest-side, rgba(66,92,235,${o}), rgba(66,92,235,${o * 0.35}) 45%, transparent)`, pointerEvents: "none", mixBlendMode: "multiply" }} />
  );
};

/** A rounded rect that morphs between two boxes (screen space). */
export const MorphRect: React.FC<{ from: [number, number, number, number]; to: [number, number, number, number]; at: number; len?: number; color?: string; fromRadius?: number; toRadius?: number; fadeAt?: number; fill?: string; border?: string }> = ({ from, to, at, len = 16, color = C.blue, fromRadius = 6, toRadius = 22, fadeAt, fill, border }) => {
  const f = useFrame();
  const t = p01(f, at, at + len, inOut);
  const v = (i: number) => from[i] + (to[i] - from[i]) * t;
  const fade = fadeAt === undefined ? 1 : 1 - p01(f, fadeAt, fadeAt + 8, inOut);
  if (fade <= 0) return null;
  const bg = fill ? interpolateColors(t, [0, 1], [color, fill]) : color;
  return (
    <div style={{ position: "absolute", left: v(0) - v(2) / 2, top: v(1) - v(3) / 2, width: v(2), height: v(3), borderRadius: fromRadius + (toRadius - fromRadius) * t, background: bg, border: border && t > 0.5 ? border : undefined, opacity: fade }} />
  );
};

/** Square brackets that open around their content. */
export const Brackets: React.FC<{ at: number; size: number; color?: string; gap?: number; children: React.ReactNode; until?: number }> = ({ at, size, color = C.blue, gap = 40, children, until }) => {
  const f = useFrame();
  const t = p01(f, at, at + 14, inOut);
  const b = (side: "l" | "r") => (
    <svg width={size * 0.28} height={size * 1.2} viewBox="0 0 28 120" style={{ opacity: t, translate: `${(side === "l" ? 1 : -1) * (1 - t) * 60}px 0px` }}>
      <path d={side === "l" ? "M24 4 H6 V116 H24" : "M4 4 H22 V116 H4"} fill="none" stroke={color} strokeWidth={6} strokeLinecap="square" />
    </svg>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap, ...blurOut(f, until) }}>
      {b("l")}
      {children}
      {b("r")}
    </div>
  );
};

// ---- App placement ---------------------------------------------------------
export const APP = { x: 96, y: 0, s: 1.35, w: 1280, h: 800 };
/** App coordinates (1280 × 800) → stage coordinates. */
export const appPt = (ax: number, ay: number): [number, number] => [APP.x + ax * APP.s, APP.y + ay * APP.s];

/** The real app placed full-height on the stage (1728 × 1080). */
export const AppStage: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ position: "absolute", left: APP.x, top: APP.y, width: APP.w, height: APP.h, transformOrigin: "0 0", transform: `scale(${APP.s})`, borderRadius: 14, boxShadow: "0 0 0 1px rgba(16,20,42,0.06), 0 40px 90px -30px rgba(16,20,42,0.35)", ...style }}>
    {children}
  </div>
);

/** Plain canvas background. */
export const Canvas: React.FC<{ color?: string }> = ({ color = C.canvas }) => <AbsoluteFill style={{ background: color }} />;

/** Drift so nothing sits perfectly still (≤ 4px). */
export const drift = (f: number, amp = 4) => ({ x: Math.sin(f / 40) * amp, y: Math.cos(f / 53) * amp * 0.6 });
