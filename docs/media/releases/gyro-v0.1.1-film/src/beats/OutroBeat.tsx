import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion";
import { Say } from "../ui/kinetic";
import { GyroMark } from "../ui/parts";
import { Camera, clamp } from "../ui/motion";
import { Badge, BlackPill, Dial, Needle, SiteBg, WhitePill } from "../ui/site";
import { C, display, inOut, mono, out, prog } from "../ui/theme";

/**
 * Close, in the usegyro.io hero style: a dial of ticks rises along the bottom,
 * the indigo-to-coral needle swings up through it, and the Gyro lockup, the
 * release badge and the two ways to get it settle above.
 */
const RECAP = 120;
const LOCKUP_FRAMES = 210;
export const OUTRO_FRAMES = RECAP + LOCKUP_FRAMES;

const PIVOT = { x: 960, y: 1720 };
const MARK_AT = 14;
const WORD_AT = 34;
const BADGE_AT = 52;
const TAG_AT = 64;
const CTA_AT = 84;
const END = LOCKUP_FRAMES - 20;

const WORD_W = 420;
const GAP = 40;
const MARK = 160;

const up = (frame: number, at: number, len = 20, dist = 24) => {
  const p = prog(frame, at, at + len, out);
  return { opacity: p, translate: `0 ${(1 - p) * dist}px`, filter: p < 0.99 ? `blur(${(1 - p) * 10}px)` : undefined } as React.CSSProperties;
};

const Lockup: React.FC = () => {
  const frame = useCurrentFrame();
  const swing = prog(frame, 4, 86, inOut);
  const angle = interpolate(swing, [0, 1], [-52, 14]) + Math.sin(frame / 30) * 0.8 * swing;
  const dial = prog(frame, 0, 46, out);
  const slide = prog(frame, WORD_AT - 4, WORD_AT + 22, inOut);
  const wipe = prog(frame, WORD_AT, WORD_AT + 24, inOut);
  const fade = interpolate(frame, [END, LOCKUP_FRAMES - 2], [1, 0], clamp);
  const push = interpolate(frame, [0, LOCKUP_FRAMES], [1.04, 1]);

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: fade, scale: push }}>
        <Needle cx={PIVOT.x} cy={PIVOT.y} angle={angle} reach={1700} opacity={prog(frame, 2, 30)} />
        <Dial cx={PIVOT.x} cy={PIVOT.y} r={900} from={-46} to={46} count={47} draw={dial} active={angle} />

        <AbsoluteFill style={{ alignItems: "center" }}>
          <div style={{ position: "absolute", top: 236, ...up(frame, BADGE_AT) }}>
            <Badge dot={C.coral} size={30}>
              v0.1.1 is out
            </Badge>
          </div>

          {/* Lockup: the mark assembles at centre, then steps aside for the wordmark. */}
          <div style={{ position: "absolute", top: 330, height: 200, left: 960, width: 0 }}>
            <div
              style={{
                position: "absolute",
                left: -(MARK + GAP + WORD_W) / 2 + (1 - slide) * ((GAP + WORD_W) / 2),
                top: 100 - MARK / 2,
              }}
            >
              <GyroMark size={MARK} color={C.ink} assembleAt={MARK_AT} />
            </div>
            <div
              style={{
                position: "absolute",
                left: -(MARK + GAP + WORD_W) / 2 + MARK + GAP,
                top: 0,
                height: 200,
                width: WORD_W + 40,
                clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)`,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  fontFamily: display,
                  fontWeight: 560,
                  fontSize: 190,
                  lineHeight: "200px",
                  letterSpacing: -190 * 0.05,
                  color: C.ink,
                  translate: `${(1 - wipe) * -60}px 0`,
                }}
              >
                Gyro
              </span>
            </div>
          </div>

          <div style={{ position: "absolute", top: 560, fontFamily: display, fontSize: 46, fontWeight: 450, letterSpacing: -1.2, color: C.muted, ...up(frame, TAG_AT) }}>
            Coding with AI, done better.
          </div>

          <div style={{ position: "absolute", top: 676, display: "flex", gap: 24, alignItems: "center" }}>
            <div style={up(frame, CTA_AT, 22, 30)}>
              <BlackPill size={42}>
                usegyro.io
                <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </BlackPill>
            </div>
            <div style={up(frame, CTA_AT + 10, 22, 30)}>
              <WhitePill size={30} style={{ padding: "26px 36px" }}>
                <span style={{ color: C.faint, fontFamily: mono }}>$&nbsp;</span>brew upgrade wytzeh197/tap/gyro
              </WhitePill>
            </div>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** A short recap in type, then the lockup. */
export const OutroBeat: React.FC = () => (
  <AbsoluteFill>
    <SiteBg />
    <Camera keys={[[0, 960, 590, 1.14], [RECAP, 960, 520, 0.98]]}>
    <Say
      at={6}
      out={RECAP - 18}
      size={112}
      stagger={5}
      lines={[
        ["Easier", "to", "read."],
        [{ t: "Fewer", after: 8 }, "surprises."],
        [{ t: "Smoother", after: 8, color: C.blue }, { t: "underneath.", color: C.blue }],
      ]}
    />
    </Camera>
    <Sequence from={RECAP} layout="none">
      <Lockup />
    </Sequence>
  </AbsoluteFill>
);
