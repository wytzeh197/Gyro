import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Camera, Odometer, Streaks, clamp } from "../ui/motion";
import { Say } from "../ui/kinetic";
import { SiteBg } from "../ui/site";
import { Region, Win } from "../ui/win";
import { C, inOut, mono, out, prog, text } from "../ui/theme";

/**
 * The backend rebuild. A reveal on the streaks, then the camera starts close
 * on the one big file in a real explorer window: its line count rolls down
 * while sixteen folders cascade in underneath. The camera pulls back to the
 * plain sentence beside it, then tilts down to what it means for the user.
 */
export const REBUILD_FRAMES = 336;

const HOOD = 6;
const HOOD_OUT = 46;
const COUNT = 76; // line count starts falling
const COUNT_LEN = 40;
const FOLDERS = 120;
const TEXT = 150;
const TILT = 212;
const BENEFIT = 226;

const BEFORE = 25802;
const AFTER = 122;

// The desktop backend's domain folders in v0.1.1.
const DOMAINS = [
  "providers", "git", "capabilities", "sessions",
  "ide", "workspace", "app", "usage",
  "browser", "terminal", "automation", "state",
  "diagnostics", "council", "ipc", "timeline",
];

const EX = { x: 1000, y: 110, w: 840, h: 860 };

const FileIcon: React.FC<{ size: number; color?: string }> = ({ size, color = C.coral }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

const FolderIcon: React.FC<{ size: number; color?: string }> = ({ size, color = C.blue }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

/** The explorer: lib.rs with its rolling count and bar, then the folders. */
const Explorer: React.FC = () => {
  const frame = useCurrentFrame();
  const t = prog(frame, COUNT, COUNT + COUNT_LEN, inOut);
  const tp = prog(frame - 1, COUNT, COUNT + COUNT_LEN, inOut);
  const lines = interpolate(t, [0, 1], [BEFORE, AFTER]);
  const prev = interpolate(tp, [0, 1], [BEFORE, AFTER]);
  const BAR = EX.w - 96;
  const fill = prog(frame, 56, 74, out);
  const done = frame >= COUNT + COUNT_LEN - 6;
  const tone = done ? C.blue : C.coral;
  return (
    <Win x={EX.x} y={EX.y} w={EX.w} h={EX.h} title="src-tauri/src" at={48}>
      <div style={{ position: "absolute", left: 48, right: 48, top: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, height: 60 }}>
          <FileIcon size={38} color={tone} />
          <span style={{ fontFamily: mono, fontSize: 34, color: C.ink, flex: 1 }}>lib.rs</span>
          <Odometer value={lines} prev={prev} digits={5} size={46} weight={560} color={C.ink} commas />
          <span style={{ fontFamily: text, fontSize: 28, color: C.muted, marginLeft: 12 }}>lines</span>
        </div>
        <div style={{ marginTop: 22, height: 16, borderRadius: 16, background: "#EEEFF4" }}>
          <div style={{ width: Math.max(12, BAR * fill * (lines / BEFORE)), height: 16, borderRadius: 16, background: tone }} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 48, right: 48, top: 170, height: 1.5, background: C.line, opacity: prog(frame, FOLDERS - 6, FOLDERS + 6) }} />
      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          top: 196,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridAutoFlow: "column",
          gridTemplateRows: "repeat(8, 70px)",
          columnGap: 24,
        }}
      >
        {DOMAINS.map((name, k) => {
          const p = prog(frame, FOLDERS + k * 3, FOLDERS + k * 3 + 16, out);
          return (
            <div
              key={name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                opacity: p,
                translate: `${(1 - p) * -30}px 0`,
                filter: p < 0.99 ? `blur(${(1 - p) * 8}px)` : undefined,
                fontFamily: text,
                fontSize: 30,
                fontWeight: 500,
                color: C.ink,
              }}
            >
              <FolderIcon size={32} />
              {name}
            </div>
          );
        })}
      </div>
    </Win>
  );
};

export const RebuildBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const streaks = 1 - prog(frame, HOOD_OUT + 2, HOOD_OUT + 16, inOut);
  const drift = interpolate(frame, [0, 70], [0, 120], clamp);
  return (
    <AbsoluteFill>
      <SiteBg />
      <Camera
        keys={[
          [60, 1420, 250, 1.9],
          [COUNT + COUNT_LEN, 1430, 262, 1.82],
          [COUNT + COUNT_LEN + 22, 1420, 560, 1.18],
          [TEXT - 4, 1300, 560, 1.12],
          [TEXT + 18, 960, 540, 1],
          [TILT - 6, 975, 548, 1.04],
          [TILT + 14, 960, 1620, 1],
          [REBUILD_FRAMES, 960, 1636, 1.07],
        ]}
      >
        <Explorer />

        {/* The plain sentence beside the window. */}
        <Region x={-430}>
          <Say
            at={TEXT}
            out={TILT}
            size={100}
            lines={[
              ["We", "rebuilt"],
              ["the", { t: "backend.", color: C.blue }],
            ]}
          />
        </Region>

        {/* What it means for you. */}
        <Region y={1080}>
          <Say
            at={BENEFIT}
            size={124}
            y={-40}
            lines={[
              ["So", "Gyro", "runs"],
              [{ t: "smoother", color: C.blue }, "for", "you."],
            ]}
          />
          <Say
            at={BENEFIT + 40}
            size={48}
            weight={500}
            color={C.muted}
            y={190}
            lines={[["Fixes", "and", "new", "features", "land", "more", "easily."]]}
          />
        </Region>
      </Camera>

      {/* The reveal */}
      <AbsoluteFill style={{ opacity: streaks }}>
        <Streaks drift={drift} />
        <Say at={HOOD} out={HOOD_OUT} size={150} color="#fff" stagger={6} lines={[["Under", "the", "hood."]]} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
