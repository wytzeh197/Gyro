import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { GyroMark } from "../ui/parts";
import { At, Camera, Center, DARK_DIM, DARK_TEXT, DarkBg, Words, blurIn, clamp, focusOut } from "../ui/motion";
import { C, display, inOut, mono, prog } from "../ui/theme";

const BEFORE = 25802;
const AFTER = 122;
const ADAPTERS = ["Codex", "Claude", "ACP", "Antigravity", "API", "Ollama"];

// Bar beat
const FILL = 48;
const SHRINK = 78;
const SHRUNK = 118;
// Camera move down to the diagram
const PAN = 134;
const LANDED = 156;
const FOCUS = 236;

// Diagram lives one screen below, centred on (960, 1620).
const DY = 1080;
const CHIP = { x: 330, w: 300, h: 74, gap: 22 };
const chipY = (i: number) => DY + 540 - (6 * CHIP.h + 5 * CHIP.gap) / 2 + i * (CHIP.h + CHIP.gap);
const CORE = { x: 820, y: DY + 400, w: 280, h: 280 };
const OUT = { x: 1290, w: 300, h: 92 };
const OUTS = [
  { label: "Desktop", y: DY + 540 - 130 },
  { label: "CLI", y: DY + 540 + 130 },
];

type P = [number, number];
const cubic = (a: P, b: P, c: P, d: P, t: number): P => {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
};

const Link: React.FC<{ a: P; d: P; draw: number; pulse: number; strong?: boolean }> = ({ a, d, draw, pulse, strong }) => {
  const mx = (a[0] + d[0]) / 2;
  const b: P = [mx, a[1]];
  const c: P = [mx, d[1]];
  const path = `M${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`;
  const dot = cubic(a, b, c, d, pulse % 1);
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={strong ? "#AEB8FF" : "#3A4A6A"}
        strokeWidth={strong ? 2.5 : 2}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - draw}
      />
      <circle cx={a[0]} cy={a[1]} r={5} fill={strong ? "#AEB8FF" : "#5B6B8C"} opacity={draw > 0 ? 1 : 0} />
      <circle cx={d[0]} cy={d[1]} r={5} fill={strong ? "#AEB8FF" : "#5B6B8C"} opacity={draw > 0.98 ? 1 : 0} />
      {draw > 0.98 && (
        <circle cx={dot[0]} cy={dot[1]} r={6} fill="#CFE0FF" style={{ filter: "drop-shadow(0 0 8px #425CEB)" }} />
      )}
    </g>
  );
};

const Bar: React.FC = () => {
  const frame = useCurrentFrame();
  const fill = prog(frame, FILL, FILL + 22, inOut);
  const shrink = prog(frame, SHRINK, SHRUNK, inOut);
  const lines = Math.round(interpolate(shrink, [0, 1], [BEFORE, AFTER]));
  const W = 1400;
  const width = Math.max(10, W * fill * (lines / BEFORE));
  return (
    <At x={260} y={430} w={W} h={220} style={blurIn(frame, FILL - 4, 14, 14, 16)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: mono, fontSize: 32, color: "#8A93A6" }}>src-tauri/src/lib.rs</span>
        <span style={{ fontFamily: display, fontSize: 112, fontWeight: 700, letterSpacing: -4, color: DARK_TEXT }}>
          {lines.toLocaleString("en-US")}
          <span style={{ fontSize: 36, fontWeight: 500, letterSpacing: 0, color: DARK_DIM, marginLeft: 16 }}>lines</span>
        </span>
      </div>
      <div style={{ marginTop: 22, height: 22, borderRadius: 99, background: "#1A1F29", position: "relative" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width,
            borderRadius: 99,
            background: "linear-gradient(90deg, #425CEB, #7BA6FF)",
            boxShadow: `0 0 ${28 + 30 * (1 - shrink)}px rgba(66,92,235,0.75)`,
          }}
        />
      </div>
      <div
        style={{
          marginTop: 26,
          fontFamily: mono,
          fontSize: 26,
          color: "#6E7891",
          opacity: prog(frame, SHRUNK - 4, SHRUNK + 10),
        }}
      >
        25,802 lines in 0.1.0 → split into focused modules
      </div>
    </At>
  );
};

const Diagram: React.FC = () => {
  const frame = useCurrentFrame();
  const f = frame - LANDED + 10;
  const core = prog(f, 0, 18);
  const coreC: P = [CORE.x, CORE.y + CORE.h / 2];
  const coreOut: P = [CORE.x + CORE.w, CORE.y + CORE.h / 2];
  return (
    <>
      <svg width={1920} height={2160} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        {ADAPTERS.map((a, i) => {
          const draw = prog(f, 8 + i * 3, 26 + i * 3, inOut);
          const end: P = [coreC[0], coreC[1] - 75 + i * 30];
          return (
            <Link key={a} a={[CHIP.x + CHIP.w, chipY(i) + CHIP.h / 2]} d={end} draw={draw} pulse={(frame + i * 11) / 34} />
          );
        })}
        {OUTS.map((o, i) => (
          <Link
            key={o.label}
            a={[coreOut[0], coreOut[1] - 20 + i * 40]}
            d={[OUT.x, o.y + OUT.h / 2]}
            draw={prog(f, 34 + i * 4, 52 + i * 4, inOut)}
            pulse={(frame + i * 17) / 28}
            strong
          />
        ))}
      </svg>
      {ADAPTERS.map((a, i) => (
        <At
          key={a}
          x={CHIP.x}
          y={chipY(i)}
          w={CHIP.w}
          h={CHIP.h}
          style={{
            borderRadius: 18,
            background: "#151A23",
            border: "1px solid #283041",
            display: "flex",
            alignItems: "center",
            padding: "0 26px",
            fontFamily: display,
            fontSize: 32,
            fontWeight: 600,
            color: DARK_TEXT,
            ...blurIn(f, i * 3, 14, 12, 16),
          }}
        >
          {a}
        </At>
      ))}
      <At
        x={CORE.x}
        y={CORE.y}
        w={CORE.w}
        h={CORE.h}
        style={{
          borderRadius: 40,
          background: "linear-gradient(160deg, #425CEB, #1A4FD6)",
          boxShadow: `0 0 ${90 * core}px rgba(66,92,235,0.55), inset 0 1px 0 rgba(255,255,255,0.25)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          opacity: core,
          scale: 0.86 + 0.14 * core,
          filter: core < 0.995 ? `blur(${(1 - core) * 18}px)` : undefined,
        }}
      >
        <GyroMark size={96} color="#fff" assembleAt={LANDED - 6} />
        <span style={{ fontFamily: mono, fontSize: 30, color: "#fff" }}>gyro-core</span>
      </At>
      {OUTS.map((o, i) => (
        <At
          key={o.label}
          x={OUT.x}
          y={o.y}
          w={OUT.w}
          h={OUT.h}
          style={{
            borderRadius: 22,
            background: "#F3F5F9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: display,
            fontSize: 40,
            fontWeight: 650,
            color: C.ink,
            ...blurIn(f, 48 + i * 4, 14, 12, 16),
          }}
        >
          {o.label}
        </At>
      ))}
      <At x={330} y={DY + 120} w={1260} style={{ ...blurIn(f, 56, 16, 10, 12) }}>
        <div style={{ fontFamily: mono, fontSize: 26, color: "#6E7891", textAlign: "center" }}>
          six provider adapters · one runtime · shared by Desktop and CLI
        </div>
      </At>
    </>
  );
};

export const HOOD_FRAMES = 300;

export const HoodBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <DarkBg />
      <AbsoluteFill style={focusOut(frame, FOCUS, 18, 0.7)}>
        <Camera
          keys={[
            [0, 960, 540, 1],
            [PAN, 960, 540, 1.02],
            [LANDED, 960, 540 + DY, 1],
            [FOCUS + 40, 960, 540 + DY, 1.06],
          ]}
        >
          <Bar />
          <Diagram />
        </Camera>
      </AbsoluteFill>
      <Center>
        <Words words={["Rebuilt"]} at={2} out={30} size={150} color={DARK_TEXT} />
        <Words words={[{ t: "underneath.", color: "#9AA8FF" }]} at={8} out={32} size={150} color={DARK_TEXT} />
      </Center>
      <Center gap={30}>
        <Words words={["Less", "idle", "work."]} at={FOCUS + 6} size={130} color={DARK_TEXT} />
        <div style={{ ...blurIn(frame, FOCUS + 22, 16, 10, 14), opacity: interpolate(frame, [FOCUS + 22, FOCUS + 38], [0, 1], clamp) }}>
          <span style={{ fontFamily: display, fontSize: 44, fontWeight: 500, color: "#9AA4B8" }}>
            Closed editors no longer keep working in the background.
          </span>
        </div>
      </Center>
    </AbsoluteFill>
  );
};
