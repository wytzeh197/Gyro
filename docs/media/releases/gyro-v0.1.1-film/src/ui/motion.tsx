import React, { useId } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, display, inOut, prog } from "./theme";

/** Film-wide surfaces. Dark beats and light beats alternate on hard cuts. */
export const DARK = "#0D1026";
export const DARK_TEXT = "#F8F7FF";
export const DARK_DIM = "#4B5260";
export const LIGHT = "#FFFFFF";
export const LIGHT_DIM = "#C3C9D3";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Blur-to-sharp entrance: the house reveal for words and UI alike. */
export const blurIn = (frame: number, at: number, len = 16, blur = 16, rise = 22) => {
  const p = prog(frame, at, at + len);
  return {
    opacity: p,
    filter: p < 0.995 ? `blur(${(1 - p) * blur}px)` : undefined,
    translate: `0px ${(1 - p) * rise}px`,
  } as React.CSSProperties;
};

/** UI arriving from depth: scaled up, defocused, then settling into focus. */
export const depthIn = (frame: number, at: number, len = 22) => {
  const p = prog(frame, at, at + len);
  return {
    opacity: Math.min(1, p * 1.6),
    filter: p < 0.995 ? `blur(${(1 - p) * 26}px)` : undefined,
    scale: 1.12 - 0.12 * p,
  } as React.CSSProperties;
};

/** Pull focus away from a layer so type can sit on top of it. */
export const focusOut = (frame: number, at: number, len = 18, dim = 0.6) => {
  const q = prog(frame, at, at + len, inOut);
  return {
    opacity: 1 - dim * q,
    filter: q > 0.005 ? `blur(${q * 16}px)` : undefined,
    scale: 1 - 0.04 * q,
  } as React.CSSProperties;
};

export type Word = string | { t: React.ReactNode; color?: string; weight?: number };

/**
 * Kinetic line: each word blurs in on its own beat; `out` sends them up and away,
 * also word by word, so lines hand over to each other instead of fading as blocks.
 */
export const Words: React.FC<{
  words: Word[];
  at: number;
  stagger?: number;
  len?: number;
  size?: number;
  color?: string;
  weight?: number;
  out?: number;
  outStagger?: number;
  align?: "center" | "flex-start" | "flex-end";
  style?: React.CSSProperties;
}> = ({
  words,
  at,
  stagger = 4,
  len = 14,
  size = 96,
  color = C.ink,
  weight = 560,
  out,
  outStagger = 2,
  align = "center",
  style,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align,
        alignItems: "baseline",
        columnGap: size * 0.25,
        fontFamily: display,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 1.1,
        letterSpacing: -size * 0.045,
        color,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const word = typeof w === "string" ? { t: w } : w;
        const s = at + i * stagger;
        const p = prog(frame, s, s + len);
        let opacity = p;
        let blur = (1 - p) * size * 0.16;
        let ty = (1 - p) * size * 0.32;
        if (out !== undefined) {
          const q = prog(frame, out + i * outStagger, out + i * outStagger + 12, inOut);
          opacity *= 1 - q;
          blur += q * size * 0.14;
          ty -= q * size * 0.45;
        }
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
              translate: `0px ${ty}px`,
              color: word.color,
              fontWeight: word.weight,
              whiteSpace: "pre",
            }}
          >
            {word.t}
          </span>
        );
      })}
    </div>
  );
};

/** Letter-by-letter typing with a caret that holds solid while typing and blinks at rest. */
export const Typed: React.FC<{
  text: string;
  at: number;
  perChar?: number;
  caret?: boolean;
  caretColor?: string;
  caretHeight?: number;
  hideCaretAfter?: number;
  style?: React.CSSProperties;
}> = ({ text, at, perChar = 2, caret = true, caretColor = C.blue, caretHeight = 1, hideCaretAfter, style }) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor((frame - at) / perChar) + 1));
  const typing = frame >= at && n < text.length;
  const doneAt = at + text.length * perChar;
  const blinkOn = typing || frame < at || Math.floor((frame - doneAt) / 14) % 2 === 0;
  const showCaret = caret && blinkOn && (hideCaretAfter === undefined || frame < hideCaretAfter);
  return (
    <span style={{ whiteSpace: "pre", ...style }}>
      {text.slice(0, n)}
      <span
        style={{
          display: "inline-block",
          width: "0.06em",
          height: `${caretHeight}em`,
          marginLeft: "0.04em",
          verticalAlign: "-0.14em",
          background: caretColor,
          borderRadius: 2,
          opacity: showCaret ? 1 : 0,
        }}
      />
    </span>
  );
};

/** Decode effect: characters settle left to right from noise into `text`. */
export const Scramble: React.FC<{ text: string; at: number; len?: number; style?: React.CSSProperties }> = ({
  text,
  at,
  len = 24,
  style,
}) => {
  const frame = useCurrentFrame();
  const glyphs = "abcdefghijklmnopqrstuvwxyz0123456789:;/.";
  const settled = interpolate(frame, [at, at + len], [0, text.length], clamp);
  const shown = Math.min(text.length, Math.floor(settled) + 4);
  return (
    <span style={{ whiteSpace: "pre", ...style }}>
      {text
        .slice(0, frame < at ? 0 : shown)
        .split("")
        .map((ch, i) =>
          i < settled || ch === " "
            ? ch
            : glyphs[(i * 7 + Math.floor(frame / 2) * 13) % glyphs.length],
        )
        .join("")}
    </span>
  );
};

/**
 * Slot-machine list: the active line is crisp, upcoming lines wait below in grey,
 * finished lines lift away out of focus.
 */
export const Roll: React.FC<{
  items: React.ReactNode[];
  at: number;
  every: number;
  move?: number;
  lineH: number;
  dim?: number;
  height?: number;
  style?: React.CSSProperties;
}> = ({ items, at, every, move = 12, lineH, dim = 0.22, height, style }) => {
  const frame = useCurrentFrame();
  let pos = 0;
  for (let k = 1; k < items.length; k++) {
    pos += prog(frame, at + k * every, at + k * every + move, inOut);
  }
  return (
    <div style={{ position: "relative", height: height ?? lineH, ...style }}>
      {items.map((item, i) => {
        const d = i - pos;
        const opacity =
          d < 0 ? interpolate(d, [-0.8, 0], [0, 1], clamp) : interpolate(d, [0, 1, 2.6], [1, dim, 0], clamp);
        const blur = d < 0 ? -d * 14 : Math.max(0, d - 0.4) * 2;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: d * lineH,
              opacity,
              filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
              whiteSpace: "nowrap",
            }}
          >
            {item}
          </div>
        );
      })}
    </div>
  );
};

/** [frame, centre x, centre y, zoom] in 1920 × 1080 stage coordinates. */
export type CamKey = [number, number, number, number];

const camAt = (f: number, keys: CamKey[]) => {
  if (keys.length === 1) return { cx: keys[0][1], cy: keys[0][2], s: keys[0][3] };
  const fs = keys.map((k) => k[0]);
  const at = (i: 1 | 2 | 3) =>
    interpolate(
      f,
      fs,
      keys.map((k) => k[i]),
      { ...clamp, easing: inOut },
    );
  return { cx: at(1), cy: at(2), s: at(3) };
};

/**
 * A camera over a 1920 × 1080 stage. Moves between keys with the house in-out
 * curve and smears along the direction of travel, the way a real shutter would.
 */
export const Camera: React.FC<{
  keys: CamKey[];
  children: React.ReactNode;
  smear?: number;
  style?: React.CSSProperties;
}> = ({ keys, children, smear = 0.32, style }) => {
  const frame = useCurrentFrame();
  const id = "mb" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const a = camAt(frame, keys);
  const b = camAt(frame - 1, keys);
  const vx = Math.abs(a.cx - b.cx) * a.s;
  const vy = Math.abs(a.cy - b.cy) * a.s;
  const vz = Math.abs(Math.log(a.s / b.s));
  const bz = Math.min(18, vz * 90);
  const bx = Math.min(48, vx * smear) + bz;
  const by = Math.min(48, vy * smear) + bz;
  const blurred = bx > 0.4 || by > 0.4;
  return (
    <AbsoluteFill style={{ overflow: "hidden", ...style }}>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation={`${bx.toFixed(2)} ${by.toFixed(2)}`} />
        </filter>
      </svg>
      <AbsoluteFill style={{ filter: blurred ? `url(#${id})` : undefined }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${a.s}) translate(${-a.cx}px, ${-a.cy}px)`,
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Absolute-positioned block on the stage. */
export const At: React.FC<{
  x: number;
  y: number;
  w?: number;
  h?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ x, y, w, h, children, style }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h, ...style }}>{children}</div>
);

/** Centered overlay that holds a stack of kinetic lines. */
export const Center: React.FC<{ children: React.ReactNode; gap?: number; style?: React.CSSProperties }> = ({
  children,
  gap = 0,
  style,
}) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap, ...style }}>
    {children}
  </AbsoluteFill>
);

/** Soft dark surface with a faint cool vignette. */
export const DarkBg: React.FC<{ glow?: number }> = ({ glow = 1 }) => (
  <AbsoluteFill
    style={{
      backgroundColor: DARK,
      backgroundImage: `radial-gradient(1200px 700px at 50% 45%, rgba(66,92,235,${0.08 * glow}), transparent 70%)`,
    }}
  />
);

export const LightBg: React.FC = () => <AbsoluteFill style={{ backgroundColor: LIGHT }} />;

/** Deep-blue field of soft vertical streaks for the reveal. */
export const Streaks: React.FC<{ drift?: number }> = ({ drift = 0 }) => (
  <AbsoluteFill style={{ background: "linear-gradient(180deg, #141A5E 0%, #3247D8 46%, #5B6FF0 72%, #FF9C80 100%)" }}>
    <AbsoluteFill
      style={{
        backgroundImage: [
          "repeating-linear-gradient(90deg, rgba(255,255,255,0) 0px, rgba(255,255,255,0.16) 46px, rgba(255,255,255,0) 92px, rgba(255,255,255,0) 131px)",
          "repeating-linear-gradient(90deg, rgba(4,16,60,0) 0px, rgba(4,16,60,0.28) 70px, rgba(4,16,60,0) 140px, rgba(4,16,60,0) 223px)",
          "repeating-linear-gradient(90deg, rgba(160,200,255,0) 0px, rgba(160,200,255,0.22) 18px, rgba(160,200,255,0) 36px, rgba(160,200,255,0) 307px)",
        ].join(", "),
        backgroundPosition: `${drift}px 0, ${-drift * 0.6}px 0, ${drift * 1.4}px 0`,
        filter: "blur(10px)",
        scale: 1.15,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(180deg, rgba(3,10,40,0.55) 0%, rgba(3,10,40,0) 35%, rgba(3,10,40,0) 70%, rgba(255,255,255,0.18) 100%)",
      }}
    />
  </AbsoluteFill>
);

export { clamp };

/** Animated film grain laid over the whole film; reseeded every other frame. */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.07 }) => {
  const frame = useCurrentFrame();
  const id = "gr" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width={1920} height={1080}>
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={Math.floor(frame / 2) % 24} />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width={1920} height={1080} filter={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

export type Dir = "left" | "right" | "up" | "down";
const DIRV: Record<Dir, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * Whip pan at a beat's edges: the outgoing beat accelerates away along `exit`
 * with a directional smear, and the incoming one decelerates in from the
 * opposite side, so a hard cut reads as one fast camera move.
 */
export const Whip: React.FC<{
  frames: number;
  enter?: Dir;
  exit?: Dir;
  len?: number;
  children: React.ReactNode;
}> = ({ frames, enter, exit, len = 7, children }) => {
  const frame = useCurrentFrame();
  const id = "wp" + useId().replace(/[^a-zA-Z0-9]/g, "");
  let tx = 0;
  let ty = 0;
  let amt = 0;
  let dir: [number, number] = [0, 0];
  if (exit && frame >= frames - len) {
    const t = interpolate(frame, [frames - len, frames], [0, 1], clamp);
    amt = t * t;
    dir = DIRV[exit];
    tx = dir[0] * 240 * amt;
    ty = dir[1] * 150 * amt;
  } else if (enter && frame < len) {
    const t = 1 - interpolate(frame, [0, len], [0, 1], clamp);
    amt = t * t;
    dir = DIRV[enter];
    tx = -dir[0] * 240 * amt;
    ty = -dir[1] * 150 * amt;
  }
  const bx = Math.abs(dir[0]) * amt * 90;
  const by = Math.abs(dir[1]) * amt * 90;
  const on = bx > 0.3 || by > 0.3;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={`${bx.toFixed(2)} ${by.toFixed(2)}`} />
        </filter>
      </svg>
      <AbsoluteFill
        style={{
          translate: `${tx}px ${ty}px`,
          // Push in while sliding so the frame never shows an edge.
          scale: 1 + amt * 0.32,
          filter: on ? `url(#${id}) brightness(${1 + amt * 0.25})` : undefined,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Odometer: every digit is a rolling column. Fast columns smear vertically,
 * and leading zeros fall away, so big drops read as one physical spin.
 */
export const Odometer: React.FC<{
  value: number;
  prev?: number;
  digits: number;
  size: number;
  color?: string;
  weight?: number;
  commas?: boolean;
  /** Digits after a decimal point; `value` is then in whole units, e.g. 7.38. */
  decimals?: number;
  style?: React.CSSProperties;
}> = ({ value, prev = value, digits, size, color = DARK_TEXT, weight = 700, commas = true, decimals = 0, style }) => {
  const h = size * 1.04;
  const w = size * 0.6;
  const cells: React.ReactNode[] = [];
  const scale10 = Math.pow(10, decimals);
  const v = Math.max(0, value * scale10);
  prev = prev * scale10;
  for (let p = digits + decimals - 1; p >= 0; p--) {
    const place = Math.pow(10, p);
    // Continuous position of this column, with lower digits rolling only near their carry.
    // A column only turns while everything below it is rolling over from 9s.
    const carry = Math.max(0, (v % place) - (place - 1));
    const pos = (Math.floor(v / place) % 10) + carry;
    const speed = Math.abs(v - prev) / place;
    const blur = Math.min(size * 0.12, speed * size * 0.05);
    const vis = p <= decimals ? 1 : interpolate(v / place, [0.9, 1], [0, 1], clamp);
    cells.push(
      <span
        key={"d" + p}
        style={{
          position: "relative",
          display: "inline-block",
          width: w * vis,
          height: h,
          overflow: "hidden",
          opacity: vis,
          // Soft top and bottom edges so a smeared column never shows its box.
          maskImage: blur > 0.3 ? "linear-gradient(transparent, #000 22%, #000 78%, transparent)" : undefined,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: -pos * h,
            display: "flex",
            flexDirection: "column",
            filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
          }}
        >
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d, i) => (
            <span key={i} style={{ height: h, lineHeight: `${h}px`, width: w, textAlign: "center" }}>
              {d}
            </span>
          ))}
        </span>
      </span>,
    );
    if (decimals > 0 && p === decimals) {
      cells.push(
        <span key="dot" style={{ display: "inline-block", width: size * 0.26, textAlign: "center" }}>
          .
        </span>,
      );
    }
    const q = p - decimals;
    if (commas && q > 0 && q % 3 === 0 && vis > 0) {
      cells.push(
        <span key={"c" + p} style={{ display: "inline-block", width: size * 0.26 * vis, opacity: vis, textAlign: "center", overflow: "hidden" }}>
          ,
        </span>,
      );
    }
  }
  return (
    <span
      style={{
        display: "inline-flex",
        fontFamily: display,
        fontWeight: weight,
        fontSize: size,
        letterSpacing: 0,
        color,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1,
        ...style,
      }}
    >
      {cells}
    </span>
  );
};
