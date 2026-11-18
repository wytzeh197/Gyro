// Bold toolkit: saturated fields, heavy slammed type, scrolling marquees,
// label-tape headlines and sticker callouts.
import { useFrame } from "../pace";
import React from "react";
import { AbsoluteFill, interpolate, spring } from "remotion";
import { C, display, inOut, mono, prog } from "./theme";

export const INK = "#10142A";
export const WHITE = "#F8F7FF";
export const FIELDS = { blue: C.blue, coral: C.coral, ink: INK, white: "#F5F5F8" } as const;
export type FieldName = keyof typeof FIELDS;
export const onField = (f: FieldName) => (f === "white" ? INK : WHITE);

const sp = (frame: number, at: number, stiff = 210, damping = 15) =>
  spring({ frame: frame - at, fps: 30, config: { stiffness: stiff, damping, mass: 0.7 } });

/** Full-bleed saturated colour with a drifting dot grid. */
export const Field: React.FC<{ color: FieldName; grid?: boolean; children?: React.ReactNode }> = ({ color, grid = true, children }) => {
  const frame = useFrame();
  const dot = color === "white" ? "rgba(16,20,42,0.10)" : "rgba(255,255,255,0.13)";
  return (
    <AbsoluteFill style={{ backgroundColor: FIELDS[color] }}>
      {grid && (
        <AbsoluteFill
          style={{
            backgroundImage: `radial-gradient(${dot} 2.2px, transparent 2.6px)`,
            backgroundSize: "56px 56px",
            backgroundPosition: `${-frame * 0.8}px ${frame * 0.4}px`,
          }}
        />
      )}
      {children}
    </AbsoluteFill>
  );
};

/** Giant line of type scrolling across the frame forever. */
export const Marquee: React.FC<{
  text: string;
  y: number;
  size?: number;
  speed?: number;
  color?: string;
  outline?: boolean;
  start?: number;
}> = ({ text, y, size = 320, speed = 7, color = "rgba(255,255,255,0.14)", outline = false, start = 0 }) => {
  const frame = useFrame();
  return (
    <div
      style={{
        position: "absolute",
        top: y,
        left: 0,
        whiteSpace: "nowrap",
        fontFamily: display,
        fontWeight: 850,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: -size * 0.05,
        color: outline ? "transparent" : color,
        WebkitTextStroke: outline ? `3px ${color}` : undefined,
        translate: `${start - frame * speed}px 0px`,
      }}
    >
      {Array.from({ length: 8 }, () => text + " ").join("")}
    </div>
  );
};

export type Bold = string | { t: string; color?: string };

/** Heavy words that punch up out of a mask with a springy overshoot. */
export const Slam: React.FC<{
  words: Bold[];
  at: number;
  stagger?: number;
  size?: number;
  color?: string;
  weight?: number;
  out?: number;
  align?: "center" | "flex-start" | "flex-end";
  style?: React.CSSProperties;
}> = ({ words, at, stagger = 3, size = 220, color = WHITE, weight = 820, out, align = "center", style }) => {
  const frame = useFrame();
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align,
        columnGap: size * 0.22,
        fontFamily: display,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: -size * 0.055,
        color,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const word = typeof w === "string" ? { t: w } : w;
        const s = sp(frame, at + i * stagger);
        let ty = (1 - s) * 105;
        let sc = 0.7 + 0.3 * s;
        if (out !== undefined) {
          const q = prog(frame, out + i * 2, out + i * 2 + 9, inOut);
          ty -= q * 110;
          sc += q * 0.1;
        }
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", padding: `${size * 0.04}px ${size * 0.03}px ${size * 0.14}px`, margin: `${-size * 0.04}px ${-size * 0.03}px ${-size * 0.14}px` }}>
            <span
              style={{
                display: "inline-block",
                translate: `0px ${ty}%`,
                scale: `${sc}`,
                transformOrigin: "50% 100%",
                color: word.color,
                whiteSpace: "pre",
                opacity: frame < at + i * stagger ? 0 : 1,
              }}
            >
              {word.t}
            </span>
          </span>
        );
      })}
    </div>
  );
};

/** Label-tape headline: each line is a solid block that wipes open, text punching up inside. */
export type SlabLine = { t: React.ReactNode; bg: string; fg: string };
export const Slab: React.FC<{
  at: number;
  until?: number;
  lines: SlabLine[];
  size?: number;
  x?: number;
  bottom?: number;
  top?: number;
  rot?: number;
}> = ({ at, until, lines, size = 92, x = 84, bottom = 84, top, rot = -2 }) => {
  const frame = useFrame();
  if (frame < at) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        ...(top !== undefined ? { top } : { bottom }),
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
        rotate: `${rot}deg`,
        pointerEvents: "none",
      }}
    >
      {lines.map((l, i) => {
        const s0 = at + i * 5;
        const open = interpolate(sp(frame, s0, 260, 26), [0, 1], [0, 100]);
        const s = sp(frame, s0 + 4);
        const shut = until === undefined ? 0 : prog(frame, until + i * 3, until + i * 3 + 9, inOut) * 100;
        return (
          <div
            key={i}
            style={{
              background: l.bg,
              color: l.fg,
              fontFamily: display,
              fontWeight: 820,
              fontSize: size,
              lineHeight: 1,
              letterSpacing: -size * 0.045,
              padding: `${size * 0.14}px ${size * 0.3}px ${size * 0.2}px`,
              clipPath: `inset(0 ${100 - open}% 0 ${shut}%)`,
              overflow: "hidden",
              boxShadow: `${size * 0.08}px ${size * 0.08}px 0 rgba(16,20,42,0.35)`,
            }}
          >
            <div style={{ translate: `0px ${(1 - s) * 110}%`, whiteSpace: "nowrap" }}>{l.t}</div>
          </div>
        );
      })}
    </div>
  );
};

/** Sticker callout that pops on with a spin and a hard ink shadow. */
export const Pop: React.FC<{
  at: number;
  until?: number;
  x: number;
  y: number;
  rot?: number;
  bg?: string;
  fg?: string;
  size?: number;
  monoFont?: boolean;
  children: React.ReactNode;
}> = ({ at, until, x, y, rot = -4, bg = WHITE, fg = INK, size = 44, monoFont = false, children }) => {
  const frame = useFrame();
  if (frame < at) return null;
  const s = sp(frame, at, 260, 11);
  const q = until === undefined ? 0 : prog(frame, until, until + 8, inOut);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        translate: "-50% -50%",
        scale: `${s * (1 - q)}`,
        rotate: `${rot + (1 - s) * rot * 4}deg`,
        background: bg,
        color: fg,
        border: `4px solid ${INK}`,
        borderRadius: size * 0.36,
        padding: `${size * 0.28}px ${size * 0.5}px`,
        fontFamily: monoFont ? mono : display,
        fontWeight: monoFont ? 600 : 780,
        fontSize: size,
        letterSpacing: monoFont ? -size * 0.02 : -size * 0.03,
        lineHeight: 1,
        whiteSpace: "nowrap",
        boxShadow: `${size * 0.16}px ${size * 0.16}px 0 ${INK}`,
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
};

/** Three-frame colour flash, used to punctuate a hard cut. */
export const Flash: React.FC<{ at: number; color?: string; len?: number }> = ({ at, color = WHITE, len = 4 }) => {
  const frame = useFrame();
  if (frame < at || frame >= at + len) return null;
  return <AbsoluteFill style={{ background: color, opacity: 1 - (frame - at) / len }} />;
};
