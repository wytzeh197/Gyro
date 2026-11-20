// Film-wide motifs: the blinking block cursor and panels that tile together.
import { useFrame } from "../pace";
import React from "react";
import { AbsoluteFill, interpolate, spring } from "remotion";
import { C, display, inOut, out, prog, text } from "./theme";
import { blurIn, clamp } from "./motion";

/** Terminal block cursor `▌`. Blinks on a 15-frame cycle unless `solid`. */
export const Cursor: React.FC<{ h: number; color?: string; at?: number; solid?: boolean; style?: React.CSSProperties }> = ({
  h,
  color = C.blue,
  at = 0,
  solid = false,
  style,
}) => {
  const frame = useFrame();
  const on = solid || Math.floor((frame - at) / 15) % 2 === 0;
  return (
    <span
      style={{
        display: "inline-block",
        width: h * 0.5,
        height: h,
        background: color,
        borderRadius: h * 0.06,
        opacity: frame < at ? 0 : on ? 1 : 0,
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
};

/**
 * Panels tiling together: each rect grows out of the cursor's spot
 * (`ox`,`oy`) into its slot, staggered.
 */
export const Tiles: React.FC<{
  at: number;
  ox: number;
  oy: number;
  rects: { x: number; y: number; w: number; h: number; color?: string }[];
  stagger?: number;
  len?: number;
  radius?: number;
}> = ({ at, ox, oy, rects, stagger = 4, len = 20, radius = 18 }) => {
  const frame = useFrame();
  return (
    <AbsoluteFill>
      {rects.map((r, i) => {
        const p = prog(frame, at + i * stagger, at + i * stagger + len, inOut);
        const x = interpolate(p, [0, 1], [ox, r.x]);
        const y = interpolate(p, [0, 1], [oy, r.y]);
        const w = interpolate(p, [0, 1], [24, r.w]);
        const hh = interpolate(p, [0, 1], [48, r.h]);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: w,
              height: hh,
              borderRadius: interpolate(p, [0, 1], [3, radius]),
              background: r.color ?? C.blue,
              opacity: frame < at + i * stagger ? 0 : 1,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Short line of copy in a soft pill near the bottom of an app beat. */
export const Caption: React.FC<{ at: number; until?: number; children: React.ReactNode; dark?: boolean }> = ({
  at,
  until,
  children,
  dark = false,
}) => {
  const frame = useFrame();
  const inn = blurIn(frame, at, 14, 12, 18);
  const o = until === undefined ? 1 : 1 - prog(frame, until, until + 10, inOut);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 46, pointerEvents: "none" }}>
      <div
        style={{
          ...inn,
          opacity: (inn.opacity as number) * o,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "16px 30px 16px 24px",
          borderRadius: 999,
          background: dark ? "rgba(13,16,38,0.92)" : "rgba(16,20,42,0.9)",
          color: "#F8F7FF",
          fontFamily: display,
          fontWeight: 560,
          fontSize: 38,
          letterSpacing: -1,
          boxShadow: "0 20px 60px -20px rgba(16,20,42,0.5)",
          backdropFilter: "blur(12px)",
        }}
      >
        <Cursor h={30} color="#8FA0FF" at={at} />
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** App window: swings in from a 3D tilt, then sits flat with a hard offset shadow. */
export const Window: React.FC<{
  s?: number;
  x?: number;
  y?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
  shadow?: string;
  tilt?: boolean;
}> = ({ s = 1.18, x = 960, y = 540, children, style, shadow = "#10142A", tilt = true }) => {
  const frame = useFrame();
  const sp = tilt ? spring({ frame, fps: 30, config: { stiffness: 120, damping: 17, mass: 0.9 } }) : 1;
  const ry = (1 - sp) * -22;
  const rx = (1 - sp) * 12;
  const sc = s * (0.8 + 0.2 * sp);
  const off = 26 * sp;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translate(-50%, -50%) perspective(2600px) rotateY(${ry}deg) rotateX(${rx}deg) scale(${sc})`,
        borderRadius: 14,
        boxShadow: `${off}px ${off}px 0 ${shadow}, 0 40px 120px -30px rgba(16,20,42,0.45)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const FIELD = { blue: C.blue, coral: C.coral, ink: "#10142A", white: "#F5F5F8" } as const;
/** Saturated full-bleed stage with a drifting dot grid. */
export const Stage: React.FC<{ children?: React.ReactNode; color?: keyof typeof FIELD }> = ({ children, color = "blue" }) => {
  const frame = useFrame();
  const dot = color === "white" ? "rgba(16,20,42,0.10)" : "rgba(255,255,255,0.14)";
  return (
    <AbsoluteFill style={{ backgroundColor: FIELD[color] }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${dot} 2.2px, transparent 2.6px)`,
          backgroundSize: "56px 56px",
          backgroundPosition: `${-frame * 0.8}px ${frame * 0.4}px`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

export { clamp, out, text };
