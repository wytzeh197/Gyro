import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { At, Camera, Center, LightBg, Scramble, Words, clamp, depthIn, focusOut } from "../ui/motion";
import { C, cardStyle, inOut, mono, prog, text } from "../ui/theme";

export const BRANCHES_FRAMES = 202;

const PRESS = 24;
const OPEN = 28;
const SORT = 58;
const FOCUS = 130;

// Alphabetical order first, the way a plain branch list reads.
const BRANCHES = [
  { name: "backend-split", detail: "Last commit 2h ago", rank: 2 },
  { name: "chat-fixes", detail: "Last commit 4m ago", rank: 1, latest: true },
  { name: "heads/v0.1.1", detail: "Last commit 12m ago", rank: 0, current: true },
  { name: "main", detail: "Last commit 3d ago", rank: 3 },
  { name: "release-notes", detail: "Last commit 6d ago", rank: 4 },
];

const MENU = { x: 600, y: 372, w: 720 };
const HEAD = 74;
const ROW = 104;

const Icon: React.FC<{ d: React.ReactNode; size: number; color: string; width?: number }> = ({ d, size, color, width = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const BranchGlyph = (
  <>
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </>
);

const Pill: React.FC = () => {
  const frame = useCurrentFrame();
  const press = interpolate(frame, [PRESS, PRESS + 3, PRESS + 9], [1, 0.93, 1], clamp);
  const open = prog(frame, OPEN, OPEN + 10);
  return (
    <At
      x={760}
      y={252}
      w={400}
      h={88}
      style={{
        ...depthIn(frame, 0, 18),
        scale: press * (1.12 - 0.12 * prog(frame, 0, 18)),
        borderRadius: 24,
        background: C.card,
        border: `1.5px solid ${open > 0.5 ? "#B9CCF5" : C.line}`,
        boxShadow: `0 1px 2px rgba(16,20,42,0.05), 0 16px 40px -14px rgba(16,20,42,0.22), 0 0 0 ${6 * open}px rgba(66,92,235,0.12)`,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 26px",
      }}
    >
      <Icon d={BranchGlyph} size={34} color={C.blue} />
      <span style={{ flex: 1, fontFamily: mono, fontSize: 32, color: C.ink }}>heads/v0.1.1</span>
      <span style={{ rotate: `${open * 180}deg`, display: "flex" }}>
        <Icon d={<path d="m6 9 6 6 6-6" />} size={30} color={C.muted} width={2.4} />
      </span>
    </At>
  );
};

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const t = prog(frame, 4, PRESS - 2, inOut);
  const x = interpolate(t, [0, 1], [1260, 1092]);
  const y = interpolate(t, [0, 1], [430, 304]);
  const ring = prog(frame, PRESS, PRESS + 14);
  const leave = prog(frame, OPEN + 6, OPEN + 22, inOut);
  return (
    <div style={{ position: "absolute", left: x + leave * 160, top: y + leave * 120, opacity: (1 - leave) * prog(frame, 2, 8) }}>
      <div
        style={{
          position: "absolute",
          left: -26,
          top: -26,
          width: 52,
          height: 52,
          borderRadius: 99,
          border: `3px solid ${C.blue}`,
          opacity: frame >= PRESS ? 1 - ring : 0,
          scale: 0.4 + ring * 1.2,
        }}
      />
      <svg width="34" height="40" viewBox="0 0 17 20" style={{ position: "absolute", left: -3, top: -2, filter: "drop-shadow(0 4px 6px rgba(16,20,42,0.3))" }}>
        <path d="M1 1 L1 16 L5 12.4 L7.9 18.6 L10.6 17.4 L7.8 11.3 L13 11.3 Z" fill="#10142A" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

const Menu: React.FC = () => {
  const frame = useCurrentFrame();
  const open = prog(frame, OPEN, OPEN + 16);
  const height = HEAD + BRANCHES.length * ROW + 18;
  return (
    <At
      x={MENU.x}
      y={MENU.y}
      w={MENU.w}
      h={height}
      style={{
        ...cardStyle,
        borderRadius: 30,
        boxShadow: "0 1px 2px rgba(16,20,42,0.05), 0 40px 90px -30px rgba(16,20,42,0.35)",
        clipPath: `inset(0 0 ${(1 - open) * 100}% 0 round 30px)`,
        opacity: Math.min(1, open * 3),
        translate: `0 ${(1 - open) * -24}px`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: HEAD,
          display: "flex",
          alignItems: "center",
          padding: "8px 34px 0",
          fontFamily: text,
          fontSize: 21,
          fontWeight: 650,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: C.faint,
        }}
      >
        <span style={{ flex: 1 }}>Switch branch</span>
        <span style={{ opacity: prog(frame, SORT + 4, SORT + 16), letterSpacing: 1, textTransform: "none", fontWeight: 550, color: C.blue }}>
          Recent first
        </span>
      </div>
      {BRANCHES.map((b, i) => {
        const appear = prog(frame, OPEN + 4 + i * 3, OPEN + 18 + i * 3);
        const m = prog(frame, SORT + b.rank * 2, SORT + 20 + b.rank * 2, inOut);
        const slot = interpolate(m, [0, 1], [i, b.rank]);
        const lift = Math.sin(m * Math.PI) * (b.rank < i ? -1 : 1);
        const detail = SORT + 16 + b.rank * 4;
        const check = prog(frame, SORT + 18, SORT + 32);
        const badge = prog(frame, SORT + 30, SORT + 42);
        return (
          <div
            key={b.name}
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              top: HEAD + slot * ROW,
              height: ROW - 8,
              borderRadius: 20,
              display: "flex",
              alignItems: "center",
              gap: 20,
              padding: "0 22px",
              background: b.current ? `rgba(66,92,235,${0.08 * check})` : "transparent",
              translate: `${lift * 26}px ${(1 - appear) * 22}px`,
              scale: 1 + Math.abs(lift) * 0.04,
              zIndex: b.rank < i ? 2 : 1,
              boxShadow: Math.abs(lift) > 0.05 ? `0 ${18 * Math.abs(lift)}px 40px -18px rgba(16,20,42,${0.35 * Math.abs(lift)})` : undefined,
              opacity: appear,
              filter: appear < 0.99 ? `blur(${(1 - appear) * 8}px)` : undefined,
            }}
          >
            <Icon d={BranchGlyph} size={32} color={b.current ? C.blue : C.muted} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{ fontFamily: mono, fontSize: 31, color: C.ink, fontWeight: b.current ? 600 : 450 }}>{b.name}</span>
                {b.latest && (
                  <em
                    style={{
                      fontStyle: "normal",
                      fontFamily: text,
                      fontSize: 19,
                      fontWeight: 650,
                      color: C.blue,
                      background: C.blueSoft,
                      borderRadius: 99,
                      padding: "5px 12px",
                      opacity: badge,
                      scale: 0.6 + 0.4 * badge,
                      display: "inline-block",
                    }}
                  >
                    Latest commit
                  </em>
                )}
              </div>
              <span style={{ fontFamily: text, fontSize: 22, color: C.muted, height: 26, opacity: frame >= detail ? 1 : 0 }}>
                <Scramble text={b.detail} at={detail} len={16} />
              </span>
            </div>
            {b.current && (
              <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - check} />
              </svg>
            )}
          </div>
        );
      })}
    </At>
  );
};

export const BranchesBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LightBg />
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(900px 600px at 50% 40%, rgba(66,92,235,0.07), transparent 70%)",
        }}
      />
      <AbsoluteFill style={focusOut(frame, FOCUS, 18, 0.65)}>
        <Camera
          keys={[
            [0, 960, 296, 2.1],
            [PRESS, 960, 296, 1.9],
            [OPEN + 20, 960, 624, 1.36],
            [SORT, 960, 624, 1.38],
            [SORT + 34, 960, 590, 1.56],
            [FOCUS + 40, 960, 590, 1.64],
          ]}
        >
          <Menu />
          <Pill />
          <Cursor />
        </Camera>
      </AbsoluteFill>
      <Center>
        <Words words={["Branches", "show"]} at={FOCUS + 6} size={118} />
        <Words words={["recent", { t: "activity.", color: C.blue }]} at={FOCUS + 14} size={118} />
      </Center>
    </AbsoluteFill>
  );
};
