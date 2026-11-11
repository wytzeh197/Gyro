import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { GyroMark } from "../ui/parts";
import { At, Camera, Center, DARK_DIM, DARK_TEXT, DarkBg, Streaks, Typed, clamp } from "../ui/motion";
import { C, display, prog, text } from "../ui/theme";

const QUESTION = "What’s new in Gyro?";
const TYPE_AT = 26;
const SEND = 66;
const BTN = { x: 1450, y: 540 };
const BLUE_AT = 92;

/** Composer arrives from depth, a question is typed, and the camera dives through Send. */
const Composer: React.FC = () => {
  const frame = useCurrentFrame();
  const press = interpolate(frame, [SEND, SEND + 3, SEND + 9], [1, 0.88, 1], clamp);
  return (
    <AbsoluteFill>
      <DarkBg />
      <Camera
        keys={[
          [0, 960, 540, 0.3],
          [24, 960, 540, 1],
          [SEND + 2, 960, 540, 1.04],
          [80, BTN.x, BTN.y, 1.9],
          [BLUE_AT, BTN.x, BTN.y, 46],
        ]}
      >
        <At
          x={410}
          y={480}
          w={1100}
          h={120}
          style={{
            borderRadius: 60,
            background: "#161A21",
            border: "1px solid #272D38",
            boxShadow: "0 30px 80px -20px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            padding: "0 22px 0 44px",
            gap: 22,
          }}
        >
          <div style={{ flex: 1, fontFamily: text, fontSize: 44, fontWeight: 450, color: DARK_TEXT }}>
            {frame < TYPE_AT ? (
              <span style={{ color: DARK_DIM }}>Ask Gyro to change something…</span>
            ) : (
              <Typed text={QUESTION} at={TYPE_AT} perChar={2} caretColor={C.blue} hideCaretAfter={SEND} />
            )}
          </div>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 99,
              background: C.blue,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              scale: press,
              boxShadow: `0 0 ${30 * prog(frame, SEND, SEND + 10)}px rgba(66,92,235,0.7)`,
            }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24">
              <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </At>
      </Camera>
    </AbsoluteFill>
  );
};

/** On the far side of the button: "Introducing", then the release lockup. */
const Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  const intro = 8;
  const leave = prog(frame, 44, 56);
  const lock = prog(frame, 50, 76);
  const push = interpolate(frame, [50, 130], [1, 1.07], clamp);
  return (
    <AbsoluteFill>
      <Streaks drift={frame * 1.6} />
      {/* The flat blue of the button hands over to the streak field. */}
      <AbsoluteFill style={{ background: C.blue, opacity: 1 - prog(frame, 0, 12) }} />
      <Center>
        <div
          style={{
            fontFamily: display,
            fontWeight: 500,
            fontSize: 96,
            letterSpacing: -2.5,
            color: "#fff",
            opacity: 1 - leave,
            filter: leave > 0 ? `blur(${leave * 18}px)` : undefined,
            scale: 1 - leave * 0.12,
          }}
        >
          <Typed text="Introducing" at={intro} perChar={2} caretColor="#fff" hideCaretAfter={44} />
        </div>
      </Center>
      <Center>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 52,
            opacity: lock,
            filter: lock < 0.995 ? `blur(${(1 - lock) * 34}px)` : undefined,
            scale: (1.4 - 0.4 * lock) * push,
          }}
        >
          <GyroMark size={230} color="#fff" assembleAt={50} />
          <div
            style={{
              fontFamily: display,
              fontWeight: 700,
              fontSize: 250,
              letterSpacing: -10,
              lineHeight: 1,
              color: "#fff",
            }}
          >
            Gyro <span style={{ fontWeight: 500, color: "rgba(214,228,255,0.92)" }}>0.1.1</span>
          </div>
        </div>
      </Center>
    </AbsoluteFill>
  );
};

export const OPEN_FRAMES = 230;

export const Open: React.FC = () => (
  <AbsoluteFill>
    <Sequence durationInFrames={BLUE_AT} name="Composer dive">
      <Composer />
    </Sequence>
    <Sequence from={BLUE_AT} name="Reveal">
      <Reveal />
    </Sequence>
  </AbsoluteFill>
);
