import { AbsoluteFill, Interactive, useCurrentFrame } from "remotion";
import { Backdrop, GyroMark } from "../ui/parts";
import { C, display, mono, prog, rise, text } from "../ui/theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const settle = prog(frame, 10, 34);

  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column", gap: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <GyroMark size={130} assembleAt={0} />
          <Interactive.Div
            name="Lockup"
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 150,
              letterSpacing: -5,
              color: C.ink,
              opacity: settle,
              translate: `${(1 - settle) * -30}px 0px`,
            }}
          >
            Gyro <span style={{ color: C.blue }}>0.1.1</span>
          </Interactive.Div>
        </div>
        <Interactive.Div
          name="CTA"
          style={{ fontFamily: text, fontSize: 40, fontWeight: 500, color: C.body, ...rise(frame, 30, 18) }}
        >
          Update in the app, or download at <span style={{ color: C.ink, fontWeight: 650 }}>usegyro.io</span>
        </Interactive.Div>
        <div
          style={{
            fontFamily: mono,
            fontSize: 26,
            color: C.muted,
            padding: "12px 24px",
            borderRadius: 14,
            background: "rgba(255,255,255,0.7)",
            border: `1px solid ${C.line}`,
            ...rise(frame, 40, 18),
          }}
        >
          <span style={{ color: C.faint }}>CLI · </span>brew upgrade wytzeh197/tap/gyro
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
