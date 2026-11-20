import { loadFont } from "@remotion/fonts";
import { Easing, interpolate, staticFile } from "remotion";

loadFont({
  family: "Geist",
  url: staticFile("geist-latin.woff2"),
  weight: "100 900",
});
loadFont({
  family: "Geist Mono",
  url: staticFile("geist-mono-latin.woff2"),
  weight: "100 900",
});
loadFont({
  family: "Inter Tight",
  url: staticFile("inter-tight-latin.woff2"),
  weight: "100 900",
});
loadFont({
  family: "Inter",
  url: staticFile("inter-latin.woff2"),
  weight: "100 900",
});

export const C = {
  // usegyro.io palette
  canvas: "#F5F5F8",
  ink: "#10142A",
  body: "#3A3E55",
  muted: "#62667C",
  faint: "#9A9DB0",
  line: "#E4E5EC",
  card: "#FFFFFF",
  soft: "#F3F3F7",
  stage: "#ECEEFB",
  blue: "#425CEB",
  blueSoft: "#E3E7FD",
  coral: "#F05A34",
  coralSoft: "#FDE9E2",
  green: "#256A42",
  greenSoft: "#E3F1E8",
  amber: "#B7791F",
  amberSoft: "#FDF3E1",
  red: "#A9412F",
};

export const display = "'Geist', 'Inter Tight', system-ui, sans-serif";
export const text = "'Geist', 'Inter', system-ui, sans-serif";
export const mono = "'Geist Mono', 'SF Mono', Menlo, monospace";

export const out = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 → 1 between two frames with the house ease-out curve. */
export const prog = (
  frame: number,
  start: number,
  end: number,
  easing = out,
) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** Fade + rise for an element that enters at `start`. */
export const rise = (frame: number, start: number, distance = 28, len = 22) => {
  const p = prog(frame, start, start + len);
  return { opacity: p, translate: `0px ${(1 - p) * distance}px` };
};

export const cardStyle: React.CSSProperties = {
  background: C.card,
  borderRadius: 22,
  border: `1px solid ${C.line}`,
  boxShadow:
    "0 1px 2px rgba(16,20,42,0.04), 0 18px 48px -12px rgba(16,20,42,0.16)",
};
