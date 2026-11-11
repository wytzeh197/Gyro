import { useCurrentFrame } from "remotion";
import { FeatureFrame } from "../ui/parts";
import { C, cardStyle, display, inOut, mono, prog, rise, text } from "../ui/theme";

type Session = { title: string; project: "gyro" | "site"; mixed: number; grouped: number };

const ROW = 62;
const HEADER = 54;

// `mixed` is the old interleaved order; `grouped` the slot inside its project group.
const SESSIONS: Session[] = [
  { title: "Fix sync retries", project: "gyro", mixed: 0, grouped: 0 },
  { title: "Landing hero copy", project: "site", mixed: 1, grouped: 0 },
  { title: "Split backend modules", project: "gyro", mixed: 2, grouped: 1 },
  { title: "Pricing table", project: "site", mixed: 3, grouped: 1 },
  { title: "Slash menu polish", project: "gyro", mixed: 4, grouped: 2 },
];

const groupedY = (s: Session) =>
  s.project === "gyro"
    ? HEADER + s.grouped * ROW
    : HEADER + 3 * ROW + 14 + HEADER + s.grouped * ROW;

const PROJECT = {
  gyro: { name: "gyro", color: C.blue },
  site: { name: "gyro-website", color: C.amber },
};

export const ProjectsVignette: React.FC = () => {
  const frame = useCurrentFrame();
  const sort = prog(frame, 34, 66, inOut);
  const headers = prog(frame, 50, 70);
  const picker = prog(frame, 88, 110);

  return (
    <>
      <div style={{ position: "relative", width: 820, height: 760 }}>
        {/* Sidebar */}
        <div
          style={{
            ...cardStyle,
            position: "absolute",
            left: 0,
            top: 0,
            width: 520,
            height: 600,
            padding: "26px 22px",
            ...rise(frame, 4, 40, 26),
          }}
        >
          <div
            style={{
              fontFamily: text,
              fontSize: 19,
              fontWeight: 600,
              color: C.faint,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              marginBottom: 14,
            }}
          >
            Chats
          </div>
          <div style={{ position: "relative" }}>
            {(["gyro", "site"] as const).map((p) => (
              <div
                key={p}
                style={{
                  position: "absolute",
                  left: 6,
                  top: p === "gyro" ? 6 : 3 * ROW + 14 + HEADER + 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontFamily: display,
                  fontWeight: 600,
                  fontSize: 25,
                  color: C.ink,
                  opacity: headers,
                  translate: `${(1 - headers) * -16}px 0px`,
                }}
              >
                <svg width="26" height="26" viewBox="0 0 24 24">
                  <path
                    d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"
                    fill={PROJECT[p].color}
                    opacity={0.85}
                  />
                </svg>
                {PROJECT[p].name}
              </div>
            ))}
            {SESSIONS.map((s, i) => {
              const y = s.mixed * ROW * (1 - sort) + groupedY(s) * sort;
              const active = s.title === "Fix sync retries";
              return (
                <div
                  key={s.title}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: y,
                    height: ROW - 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: `0 16px 0 ${16 + 28 * sort}px`,
                    borderRadius: 12,
                    background: active ? C.blueSoft : "transparent",
                    fontFamily: text,
                    fontSize: 24,
                    color: active ? C.ink : C.body,
                    fontWeight: active ? 600 : 500,
                    ...rise(frame, 8 + i * 3, 18),
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: PROJECT[s.project].color,
                      opacity: 1 - sort * 0.6,
                    }}
                  />
                  {s.title}
                </div>
              );
            })}
          </div>
        </div>

        {/* Branch picker */}
        <div
          style={{
            ...cardStyle,
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 470,
            padding: 22,
            opacity: picker,
            translate: `0px ${(1 - picker) * 40}px`,
            scale: 0.94 + picker * 0.06,
          }}
        >
          <div
            style={{
              fontFamily: text,
              fontSize: 19,
              fontWeight: 600,
              color: C.faint,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              margin: "4px 8px 14px",
            }}
          >
            Switch branch
          </div>
          {[
            { name: "heads/v0.1.1", when: "now", live: true },
            { name: "backend-split", when: "1h ago" },
            { name: "main", when: "yesterday" },
          ].map((b, i) => (
            <div
              key={b.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "13px 12px",
                borderRadius: 12,
                background: i === 0 ? C.soft : "transparent",
                fontFamily: mono,
                fontSize: 23,
                color: C.ink,
                ...rise(frame, 98 + i * 5, 14),
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 99,
                  background: b.live ? C.green : C.line,
                  boxShadow: b.live
                    ? `0 0 0 ${4 + 3 * Math.abs(Math.sin(frame / 8))}px rgba(31,157,85,0.18)`
                    : "none",
                }}
              />
              <span style={{ flex: 1 }}>{b.name}</span>
              <span style={{ fontFamily: text, fontSize: 20, color: C.muted }}>{b.when}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export const Projects: React.FC = () => (
  <FeatureFrame
      index="01"
      kicker="Organisation"
      title={<>Projects stay together.</>}
      body={<>Chats group by project, and branch pickers show where work happened last.</>}
    >
    <ProjectsVignette />
  </FeatureFrame>
);
