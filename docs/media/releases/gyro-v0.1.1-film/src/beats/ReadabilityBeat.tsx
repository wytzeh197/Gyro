import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Camera } from "../ui/motion";
import { Say, Sharpen, measure } from "../ui/kinetic";
import { SiteBg } from "../ui/site";
import { Region, Win } from "../ui/win";
import { C, inOut, out, prog, text } from "../ui/theme";

/**
 * Readability: the sentence sharpens, then the camera whips across to two
 * real windows, light and dark, and a wipe swaps the old text colours for the
 * new ones while we look close. It pulls out to both side by side.
 */
export const READABILITY_FRAMES = 290;

const S1 = 6;
const S1_OUT = 90;
const LIGHT_AT = 114; // wipe on the light window
const DARK_AT = 180; // wipe on the dark window
const WIPE = 34;
const HEAD = 222;

// Real before/after text tokens.
const LIGHT = { bg: "#FFFFFF", bubble: "#F1F2F6", text: ["#252525", "#0e0e11"], faint: ["#707070", "#55555d"] };
const DARK = { bg: "#141416", bubble: "#232327", text: ["#ededed", "#f6f6f7"], faint: ["#a0a0a0", "#aaaaaf"] };

const W = { w: 780, h: 540, top: 270 };
const LX = 1990;
const DX = 2890;

/** The chat inside a window, painted in one set of colours. */
const Chat: React.FC<{ t: typeof LIGHT; v: 0 | 1 }> = ({ t, v }) => (
  <div style={{ position: "absolute", inset: 0, padding: "38px 44px", display: "flex", flexDirection: "column", gap: 26, fontFamily: text, background: t.bg }}>
    <div style={{ alignSelf: "flex-end", maxWidth: 520, padding: "18px 24px", borderRadius: 22, background: t.bubble, fontSize: 28, lineHeight: 1.35, color: t.text[v] }}>
      Make the sidebar easier to read.
    </div>
    <div style={{ fontSize: 28, lineHeight: 1.45, color: t.text[v], maxWidth: 640 }}>
      Done. Body text is darker now, and secondary text is a step stronger.
    </div>
    <div style={{ fontSize: 24, color: t.faint[v] }}>2 files changed · just now</div>
    <div style={{ marginTop: "auto", height: 70, borderRadius: 20, border: `1.5px solid ${t === LIGHT ? C.line : "#2C2C31"}`, display: "flex", alignItems: "center", padding: "0 24px", fontSize: 24, color: t.faint[v] }}>
      Ask anything…
    </div>
  </div>
);

/** Old colours underneath, new colours wiped on top with a glowing edge. */
const Swap: React.FC<{ t: typeof LIGHT; at: number }> = ({ t, at }) => {
  const frame = useCurrentFrame();
  const p = prog(frame, at, at + WIPE, inOut);
  const edge = interpolate(p, [0, 1], [0, W.w]);
  return (
    <>
      <Chat t={t} v={0} />
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${W.w - edge}px 0 0)` }}>
        <Chat t={t} v={1} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: edge - 2,
          width: 4,
          background: C.blue,
          boxShadow: "0 0 24px 6px rgba(66,92,235,0.45)",
          opacity: Math.sin(p * Math.PI),
        }}
      />
    </>
  );
};

const Label: React.FC<{ x: number; at: number; children: string }> = ({ x, at, children }) => {
  const frame = useCurrentFrame();
  const p = prog(frame, at, at + 16, out);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        width: W.w,
        top: W.top + W.h + 34,
        textAlign: "center",
        fontFamily: text,
        fontSize: 30,
        fontWeight: 500,
        color: C.muted,
        opacity: p,
        translate: `0 ${(1 - p) * 12}px`,
      }}
    >
      {children}
    </div>
  );
};

export const ReadabilityBeat: React.FC = () => (
  <AbsoluteFill>
    <SiteBg />
    <Camera
      keys={[
        [0, 960, 540, 1],
        [S1_OUT, 960, 556, 1.08],
        [108, LX + 390, 560, 1.55],
        [160, LX + 430, 540, 1.5],
        [176, DX + 390, 560, 1.55],
        [218, DX + 350, 540, 1.5],
        [242, 2830, 520, 1.04],
        [READABILITY_FRAMES, 2830, 520, 1.07],
      ]}
    >
      <Say
        at={S1}
        out={S1_OUT}
        size={120}
        lines={[
          ["Text", "is", "now"],
          ["easier", "to", { el: (s) => <Sharpen t="read." at={s + 12} />, w: measure("read.", 120) }],
        ]}
      />

      <Win x={LX} y={W.top} w={W.w} h={W.h} title="Gyro" at={94}>
        <Swap t={LIGHT} at={LIGHT_AT} />
      </Win>
      <Win x={DX} y={W.top} w={W.w} h={W.h} title="Gyro" dark at={98}>
        <Swap t={DARK} at={DARK_AT} />
      </Win>
      <Label x={LX} at={LIGHT_AT + WIPE}>
        Light mode
      </Label>
      <Label x={DX} at={DARK_AT + WIPE}>
        Dark mode
      </Label>

      <Region x={1870}>
        <Say at={HEAD} size={84} y={-390} lines={[["Sharper", "in", "light", "and", { t: "dark.", color: C.blue }]]} />
      </Region>
    </Camera>
  </AbsoluteFill>
);
