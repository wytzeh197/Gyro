import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop, GyroMark } from "../ui/parts";
import { C, display, inOut, prog, rise, text } from "../ui/theme";

/** Mark assembles, the wordmark lands, and the version rolls 0.1.0 → 0.1.1. */
export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const roll = prog(frame, 52, 70, inOut);
  const settle = prog(frame, 30, 48);

  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          gap: 44,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <GyroMark size={170} assembleAt={0} spin={(1 - settle) * -30} />
          <Interactive.Div
            name="Wordmark"
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 190,
              letterSpacing: -7,
              color: C.ink,
              opacity: settle,
              translate: `${(1 - settle) * -40}px 0px`,
            }}
          >
            Gyro
          </Interactive.Div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              fontFamily: display,
              fontWeight: 600,
              fontSize: 120,
              letterSpacing: -3,
              color: C.blue,
              opacity: prog(frame, 40, 54),
              marginLeft: 10,
            }}
          >
            0.1.
            {/* Odometer: the last digit rolls from 0 to 1. */}
            <span
              style={{
                display: "inline-block",
                height: 140,
                overflow: "hidden",
                position: "relative",
                top: 14,
              }}
            >
              <span
                style={{
                  display: "flex",
                  flexDirection: "column",
                  lineHeight: "140px",
                  translate: `0px ${-140 * roll}px`,
                }}
              >
                <span>0</span>
                <span>1</span>
              </span>
            </span>
          </div>
        </div>
        <Interactive.Div
          name="Tagline"
          style={{
            fontFamily: text,
            fontSize: 40,
            fontWeight: 500,
            color: C.muted,
            ...rise(frame, 66, 18),
          }}
        >
          What’s new in this update
        </Interactive.Div>
      </AbsoluteFill>
      {/* Soft flash as the version lands. */}
      <AbsoluteFill
        style={{
          background: C.blue,
          pointerEvents: "none",
          opacity: interpolate(frame, [68, 72, 86], [0, 0.06, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />
    </AbsoluteFill>
  );
};
