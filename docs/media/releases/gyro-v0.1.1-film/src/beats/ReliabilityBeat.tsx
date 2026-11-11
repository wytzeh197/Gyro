import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DARK_DIM, DARK_TEXT, DarkBg, Roll, Words, blurIn } from "../ui/motion";
import { C, display } from "../ui/theme";

const ITEMS = [
  "Queued messages keep their state.",
  "Usage limits come with guidance.",
  "Browser navigation is steadier.",
  "So are forms and panel sizing.",
];
const ROLL_AT = 34;
const EVERY = 30;

export const RELIABILITY_FRAMES = 186;

export const ReliabilityBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <DarkBg glow={0.7} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
        <div style={{ width: 1500, translate: "0px -40px" }}>
          <Words
            words={["Fewer", "surprises", { t: "mid-task.", color: "#9AA8FF" }]}
            at={2}
            size={68}
            color={DARK_DIM}
            weight={600}
            align="flex-start"
          />
          <div style={{ height: 34 }} />
          <div style={{ ...blurIn(frame, ROLL_AT - 10, 16, 18, 30) }}>
            <Roll
              items={ITEMS.map((t) => (
                <span
                  style={{
                    fontFamily: display,
                    fontWeight: 600,
                    fontSize: 104,
                    letterSpacing: -3.4,
                    color: DARK_TEXT,
                  }}
                >
                  {t}
                </span>
              ))}
              at={ROLL_AT}
              every={EVERY}
              move={13}
              lineH={128}
              dim={0.2}
              height={128}
            />
          </div>
        </div>
      </AbsoluteFill>
      {/* Progress ticks: one per fix, lighting up as the roll advances. */}
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 120 }}>
        <div style={{ display: "flex", gap: 14, ...blurIn(frame, ROLL_AT, 14, 8, 10) }}>
          {ITEMS.map((_, i) => {
            const on = frame >= ROLL_AT + i * EVERY + (i === 0 ? 0 : 6);
            return (
              <div
                key={i}
                style={{
                  width: on ? 54 : 18,
                  height: 6,
                  borderRadius: 9,
                  background: on ? C.blue : "#272D38",
                  boxShadow: on ? "0 0 18px rgba(66,92,235,0.7)" : undefined,
                }}
              />
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
