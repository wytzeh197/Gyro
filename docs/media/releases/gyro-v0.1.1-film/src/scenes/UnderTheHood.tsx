import { interpolate, useCurrentFrame } from "remotion";
import { FeatureFrame, GyroMark } from "../ui/parts";
import { C, cardStyle, display, inOut, mono, prog, rise, text } from "../ui/theme";

const ADAPTERS = ["Codex", "Claude", "ACP", "Antigravity", "API", "Ollama"];
const BEFORE = 25802;
const AFTER = 122;

// Diagram geometry inside the 820 × 470 lower area.
const CHIP_X = 0;
const CHIP_W = 200;
const CHIP_H = 52;
const CHIP_GAP = 18;
const CORE = { x: 300, y: 135, w: 250, h: 200 };
const OUT_X = 650;
const OUTS = [
  { label: "Desktop", y: 110 },
  { label: "CLI", y: 290 },
];

const chipY = (i: number) => i * (CHIP_H + CHIP_GAP) + 18;

export const UnderTheHood: React.FC = () => {
  const frame = useCurrentFrame();
  const shrink = prog(frame, 16, 56, inOut);
  const lines = Math.round(interpolate(shrink, [0, 1], [BEFORE, AFTER]));
  const core = prog(frame, 70, 92);
  const flow = prog(frame, 84, 118, inOut);
  const outs = prog(frame, 112, 134);
  const note = prog(frame, 136, 156);

  return (
    <FeatureFrame
      index="06"
      kicker="Under the hood"
      title={<>Rebuilt underneath.</>}
      body={<>Desktop and CLI now share one provider runtime, and Gyro does less background work while idle.</>}
    >
      <div style={{ position: "relative", width: 820, height: 800 }}>
        {/* lib.rs counter */}
        <div style={{ ...cardStyle, padding: "26px 32px", ...rise(frame, 4, 30, 22) }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontFamily: mono, fontSize: 26, color: C.ink }}>src-tauri/src/lib.rs</span>
            <span style={{ fontFamily: display, fontSize: 50, fontWeight: 700, color: C.ink, letterSpacing: -1.5 }}>
              {lines.toLocaleString("en-US")}
              <span style={{ fontFamily: text, fontSize: 22, fontWeight: 500, color: C.muted, marginLeft: 10 }}>
                lines
              </span>
            </span>
          </div>
          <div style={{ marginTop: 16, height: 14, borderRadius: 99, background: C.soft, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.max(0.6, (lines / BEFORE) * 100)}%`,
                height: "100%",
                borderRadius: 99,
                background: interpolate(shrink, [0, 1], [0, 1]) > 0.98 ? C.green : C.blue,
              }}
            />
          </div>
          <div style={{ fontFamily: text, fontSize: 19, color: C.muted, marginTop: 12 }}>
            Was {BEFORE.toLocaleString("en-US")} at 0.1.0 · now split into focused modules
          </div>
        </div>

        {/* Adapters → gyro-core → Desktop, CLI */}
        <div style={{ position: "absolute", left: 0, right: 0, top: 290, height: 470 }}>
          <svg width={820} height={470} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            {ADAPTERS.map((a, i) => {
              const y1 = chipY(i) + CHIP_H / 2;
              const y2 = CORE.y + 40 + i * 24;
              const d = `M${CHIP_X + CHIP_W} ${y1} C ${CHIP_X + CHIP_W + 60} ${y1}, ${CORE.x - 60} ${y2}, ${CORE.x} ${y2}`;
              return (
                <path
                  key={a}
                  d={d}
                  fill="none"
                  stroke={C.blue}
                  strokeOpacity={0.45}
                  strokeWidth={2}
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - prog(frame, 84 + i * 3, 104 + i * 3, inOut)}
                />
              );
            })}
            {OUTS.map((o, i) => {
              const y1 = CORE.y + CORE.h / 2;
              const y2 = o.y + 30;
              const d = `M${CORE.x + CORE.w} ${y1} C ${CORE.x + CORE.w + 50} ${y1}, ${OUT_X - 50} ${y2}, ${OUT_X} ${y2}`;
              return (
                <path
                  key={o.label}
                  d={d}
                  fill="none"
                  stroke={C.ink}
                  strokeOpacity={0.5}
                  strokeWidth={2.5}
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - prog(frame, 108 + i * 4, 126 + i * 4, inOut)}
                />
              );
            })}
          </svg>

          {ADAPTERS.map((a, i) => (
            <div
              key={a}
              style={{
                position: "absolute",
                left: CHIP_X,
                top: chipY(i),
                width: CHIP_W,
                height: CHIP_H,
                borderRadius: 14,
                background: "#fff",
                border: `1px solid ${C.line}`,
                display: "flex",
                alignItems: "center",
                padding: "0 18px",
                gap: 12,
                fontFamily: text,
                fontSize: 22,
                fontWeight: 550,
                color: C.ink,
                ...rise(frame, 60 + i * 3, 16, 16),
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: C.blue, opacity: 0.4 + flow * 0.6 }} />
              {a}
            </div>
          ))}

          <div
            style={{
              ...cardStyle,
              position: "absolute",
              left: CORE.x,
              top: CORE.y,
              width: CORE.w,
              height: CORE.h,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              background: C.ink,
              border: "none",
              opacity: core,
              scale: 0.9 + core * 0.1,
            }}
          >
            <GyroMark size={58} color="#fff" />
            <div style={{ fontFamily: mono, fontSize: 25, color: "#fff" }}>gyro-core</div>
            <div style={{ fontFamily: text, fontSize: 17, color: "rgba(255,255,255,0.65)" }}>provider runtime</div>
          </div>

          {OUTS.map((o, i) => (
            <div
              key={o.label}
              style={{
                position: "absolute",
                left: OUT_X,
                top: o.y,
                width: 170,
                height: 60,
                borderRadius: 14,
                background: C.blueSoft,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: display,
                fontWeight: 650,
                fontSize: 26,
                color: C.blue,
                opacity: prog(frame, 118 + i * 4, 134 + i * 4),
                translate: `${(1 - outs) * 20}px 0px`,
              }}
            >
              {o.label}
            </div>
          ))}
        </div>

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            textAlign: "center",
            fontFamily: text,
            fontSize: 22,
            color: C.muted,
            opacity: note,
          }}
        >
          Closed editor models are retired · less idle work in the background
        </div>
      </div>
    </FeatureFrame>
  );
};
