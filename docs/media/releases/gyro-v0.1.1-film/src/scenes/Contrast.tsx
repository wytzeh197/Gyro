import { interpolateColors, useCurrentFrame } from "remotion";
import { FeatureFrame } from "../ui/parts";
import { C, cardStyle, display, inOut, prog, rise, text } from "../ui/theme";

// Real token values before and after the contrast pass.
const THEMES = {
  light: {
    bg: "#FFFFFF",
    label: "Light",
    tokens: [
      ["Text", "#252525", "#0e0e11"],
      ["Muted", "#626262", "#3d3d44"],
      ["Faint", "#707070", "#55555d"],
    ],
  },
  dark: {
    bg: "#141416",
    label: "Dark",
    tokens: [
      ["Text", "#ededed", "#f6f6f7"],
      ["Muted", "#b5b5b5", "#c6c6ca"],
      ["Faint", "#a0a0a0", "#aaaaaf"],
    ],
  },
} as const;

const SAMPLE = ["Updated the sync retry policy", "3 files changed · 2 min ago", "Ran 18 checks in the workspace"];

const Panel: React.FC<{ theme: keyof typeof THEMES; t: number; at: number }> = ({ theme, t, at }) => {
  const frame = useCurrentFrame();
  const th = THEMES[theme];
  const dark = theme === "dark";
  return (
    <div
      style={{
        ...cardStyle,
        background: th.bg,
        border: dark ? "1px solid #2a2a2e" : cardStyle.border,
        width: 400,
        padding: "30px 30px 34px",
        ...rise(frame, at, 36, 22),
      }}
    >
      <div
        style={{
          fontFamily: text,
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          color: dark ? "#8a8a90" : C.faint,
          marginBottom: 22,
        }}
      >
        {th.label}
      </div>
      {th.tokens.map(([name, from, to], i) => (
        <div key={name} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontFamily: i === 0 ? display : text,
              fontWeight: i === 0 ? 650 : 500,
              fontSize: i === 0 ? 28 : 23,
              lineHeight: 1.3,
              color: interpolateColors(t, [0, 1], [from, to]),
            }}
          >
            {SAMPLE[i]}
          </div>
          <div style={{ fontFamily: text, fontSize: 15, color: dark ? "#77777d" : C.faint, marginTop: 4 }}>
            {name}
          </div>
        </div>
      ))}
    </div>
  );
};

export const Contrast: React.FC = () => {
  const frame = useCurrentFrame();
  const t = prog(frame, 40, 66, inOut);
  const badge = prog(frame, 62, 80);

  return (
    <FeatureFrame
      index="05"
      kicker="Readability"
      title={<>Easier to read.</>}
      body={<>Text, muted and faint colours are stronger in light and dark themes.</>}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
        <div style={{ display: "flex", gap: 28 }}>
          <Panel theme="light" t={t} at={6} />
          <Panel theme="dark" t={t} at={12} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontFamily: text, fontSize: 24 }}>
          <span style={{ color: C.muted, opacity: 1 - t * 0.5 }}>Before</span>
          <div style={{ width: 240, height: 8, borderRadius: 99, background: C.line, overflow: "hidden" }}>
            <div style={{ width: `${t * 100}%`, height: "100%", background: C.blue, borderRadius: 99 }} />
          </div>
          <span style={{ color: C.ink, fontWeight: 600, opacity: 0.5 + t * 0.5 }}>After</span>
          <span
            style={{
              marginLeft: 18,
              padding: "8px 18px",
              borderRadius: 999,
              background: C.blueSoft,
              color: C.blue,
              fontWeight: 650,
              opacity: badge,
              scale: 0.9 + badge * 0.1,
            }}
          >
            Faint text ≥ 7:1
          </span>
        </div>
      </div>
    </FeatureFrame>
  );
};
