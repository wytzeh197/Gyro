import React from "react";
import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, display, out, prog, rise, text } from "./theme";

const LOGO_PATHS = [
  "M600,234 L858,234 C901.9,233.1 941,272 940,316 L940,534 C941.5,559.8 917.9,582.1 893,582 L837,582 C813.1,581.6 792.9,572.3 776,555 L556,319 C547.5,309.4 542,298.6 543,285 C542.7,255.4 572.2,233.8 600,234 Z",
  "M466,347 C470.4,343 478.1,343.1 483,346 L583,457 C593.9,471.5 601.9,487.2 600,507 L600,551 C601.4,574.3 589.2,592 573,608 L396,761 C385.2,770.3 371.9,773.7 357,773 L248,774 C227.8,773.7 208.8,756.8 209,736 L209,617 C209.9,587.1 221.7,560.3 246,541 L466,347 Z",
  "M927,610 L1055,610 C1077.3,609.5 1096.9,629.7 1096,652 L1097,750 C1097.3,773.2 1086.9,793.3 1069,808 L842,996 C837.7,1000.7 830.5,999 826,996 L721,882 C713.2,871.7 706.2,860.9 707,847 L707,812 C706.9,787.2 720.4,768.1 739,751 L879,626 C892.8,615.4 908.4,609 927,610 Z",
  "M437,778 L474,778 C502,776.7 524.6,788.6 544,808 L733,1007 C741.1,1014.6 743.9,1024.5 745,1035 C744.9,1061.1 721.3,1082.8 695,1081 L474,1081 C433.6,1082.2 398.5,1045.9 399,1006 L399,813 C398.7,793.3 416.2,775.3 437,778 Z",
];

// Each piece flies in from its own corner of the mark.
const LOGO_FROM = [
  [220, -200],
  [-220, -160],
  [220, 200],
  [-200, 220],
];

/** The Gyro mark. `assembleAt` is the frame the pieces start flying in; omit to show it whole. */
export const GyroMark: React.FC<{
  size: number;
  assembleAt?: number;
  color?: string;
  spin?: number;
}> = ({ size, assembleAt, color = C.ink, spin = 0 }) => {
  const frame = useCurrentFrame();
  return (
    <svg
      viewBox="148 152 1010 1010"
      width={size}
      height={size}
      style={{ overflow: "visible", rotate: `${spin}deg` }}
    >
      {LOGO_PATHS.map((d, i) => {
        const p =
          assembleAt === undefined
            ? 1
            : prog(frame, assembleAt + i * 4, assembleAt + i * 4 + 26);
        const [dx, dy] = LOGO_FROM[i];
        return (
          <path
            key={d}
            d={d}
            fill={color}
            opacity={p}
            transform={`translate(${dx * (1 - p)} ${dy * (1 - p)}) rotate(${(1 - p) * 40} 652 657)`}
          />
        );
      })}
    </svg>
  );
};

/** Soft, slowly drifting canvas shared by every scene. */
export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 40;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.canvas,
        backgroundImage: `radial-gradient(1100px 700px at ${70 + drift / 20}% ${20 + drift / 30}%, rgba(66,92,235,0.10), transparent 70%), radial-gradient(900px 600px at ${10 - drift / 30}% 95%, rgba(120,150,200,0.12), transparent 70%)`,
      }}
    />
  );
};

/** Small uppercase label that sits above a scene headline. */
export const Kicker: React.FC<{ index: string; label: string; at?: number }> = ({
  index,
  label,
  at = 0,
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        fontFamily: text,
        fontSize: 22,
        fontWeight: 600,
        letterSpacing: 2.5,
        textTransform: "uppercase",
        color: C.blue,
        ...rise(frame, at, 14),
      }}
    >
      <span
        style={{
          fontFamily: display,
          fontSize: 20,
          padding: "5px 11px",
          borderRadius: 999,
          background: C.blueSoft,
          letterSpacing: 1,
        }}
      >
        {index}
      </span>
      {label}
    </div>
  );
};

/**
 * Headline column on the left, product vignette on the right.
 * Every feature scene uses this frame so the eye always knows where to read.
 */
export const FeatureFrame: React.FC<{
  index: string;
  kicker: string;
  title: React.ReactNode;
  body: React.ReactNode;
  children: React.ReactNode;
}> = ({ index, kicker, title, body, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill
        style={{
          // A gentle push-in over the whole scene keeps stills alive.
          scale: interpolate(frame, [0, durationInFrames], [1, 1.025]),
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 0,
            bottom: 0,
            width: 700,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 30,
          }}
        >
          <Kicker index={index} label={kicker} at={2} />
          <Interactive.Div
            name="Headline"
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 92,
              lineHeight: 1.0,
              letterSpacing: -3,
              color: C.ink,
              ...rise(frame, 6, 36, 26),
            }}
          >
            {title}
          </Interactive.Div>
          <Interactive.Div
            name="Body"
            style={{
              fontFamily: text,
              fontSize: 36,
              lineHeight: 1.38,
              color: C.body,
              maxWidth: 640,
              ...rise(frame, 14, 24, 26),
            }}
          >
            {body}
          </Interactive.Div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 900,
            right: 110,
            top: 110,
            bottom: 110,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Check: React.FC<{ size?: number; color?: string; draw?: number }> = ({
  size = 22,
  color = C.green,
  draw = 1,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path
      d="M5 12.5l4.5 4.5L19 7.5"
      fill="none"
      stroke={color}
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={24}
      strokeDashoffset={24 * (1 - draw)}
    />
  </svg>
);

export const easeOut = out;
