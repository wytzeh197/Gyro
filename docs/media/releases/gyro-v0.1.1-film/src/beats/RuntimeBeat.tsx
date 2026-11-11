import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Camera } from "../ui/motion";
import { Pill, Say, pillW } from "../ui/kinetic";
import { SiteBg } from "../ui/site";
import { GyroMark } from "../ui/parts";
import { Bars, Link, Region, Win } from "../ui/win";
import { C, out, prog, text } from "../ui/theme";

/**
 * One provider runtime. The headline sits above the stage; the camera tilts
 * down onto the providers, tracks along their links into one engine, and on
 * out to the desktop app and the command line, then pulls back to show it all.
 */
export const RUNTIME_FRAMES = 286;

const PROVIDERS = [
  { name: "Codex", dot: "#10A37F" },
  { name: "Claude", dot: "#D97757" },
  { name: "Kimi", dot: C.blue },
  { name: "Antigravity", dot: "#8A5CF6" },
  { name: "Ollama", dot: C.ink },
  { name: "OpenAI-compatible", dot: C.amber },
];
const PILL = 30;
const PX = 160;
const PY = (i: number) => 240 + i * 120;
const PILL_AT = 88;
const ENGINE = { x: 810, y: 390, s: 300 };
const ENGINE_AT = 120;
const IN_AT = 112;
const OUT_AT = 152;
const HOST = { x: 1340, w: 430, h: 250, top: 250, bot: 580 };
const CAPTION = 206;

const Provider: React.FC<{ i: number }> = ({ i }) => {
  const frame = useCurrentFrame();
  const p = prog(frame, PILL_AT + i * 4, PILL_AT + i * 4 + 18, out);
  return (
    <div
      style={{
        position: "absolute",
        left: PX,
        top: PY(i) - PILL * 1.05,
        opacity: p,
        translate: `${(1 - p) * -40}px 0`,
        filter: p < 0.99 ? `blur(${(1 - p) * 10}px)` : undefined,
      }}
    >
      <Pill name={PROVIDERS[i].name} dot={PROVIDERS[i].dot} size={PILL} />
    </div>
  );
};

const Engine: React.FC = () => {
  const frame = useCurrentFrame();
  const p = prog(frame, ENGINE_AT, ENGINE_AT + 22, out);
  return (
    <div
      style={{
        position: "absolute",
        left: ENGINE.x,
        top: ENGINE.y,
        width: ENGINE.s,
        height: ENGINE.s,
        borderRadius: 48,
        background: "#fff",
        border: `1.5px solid ${C.line}`,
        boxShadow: "0 50px 100px -40px rgba(66,92,235,0.45)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        opacity: p,
        scale: 0.85 + 0.15 * p,
      }}
    >
      <GyroMark size={120} assembleAt={ENGINE_AT + 4} color={C.blue} />
      <span style={{ fontFamily: text, fontSize: 30, fontWeight: 560, color: C.ink, letterSpacing: -0.5 }}>One engine</span>
    </div>
  );
};

export const RuntimeBeat: React.FC = () => {
  const ex = ENGINE.x + ENGINE.s;
  const ey = ENGINE.y + ENGINE.s / 2;
  return (
    <AbsoluteFill>
      <SiteBg />
      <Camera
        keys={[
          [0, 960, -540, 1],
          [74, 960, -520, 1.05],
          [100, 420, 540, 1.6],
          [116, 440, 540, 1.58],
          [142, 960, 540, 1.5],
          [156, 1010, 540, 1.5],
          [184, 1555, 540, 1.5],
          [200, 1560, 540, 1.46],
          [222, 960, 560, 0.98],
          [RUNTIME_FRAMES, 960, 560, 1.01],
        ]}
      >
        <Region y={-1080}>
          <Say
            at={4}
            out={76}
            size={124}
            lines={[
              ["One", "engine"],
              ["for", "every", { t: "agent.", color: C.blue }],
            ]}
          />
        </Region>

        <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
          {PROVIDERS.map((p, i) => (
            <Link key={p.name} a={[PX + pillW(p.name, PILL), PY(i)]} d={[ENGINE.x, ey]} at={IN_AT + i * 3} color={p.dot} speed={36 + i * 3} />
          ))}
          <Link a={[ex, ey]} d={[HOST.x, HOST.top + HOST.h / 2]} at={OUT_AT} />
          <Link a={[ex, ey]} d={[HOST.x, HOST.bot + HOST.h / 2]} at={OUT_AT + 4} />
        </svg>

        {PROVIDERS.map((p, i) => (
          <Provider key={p.name} i={i} />
        ))}
        <Engine />

        <Win x={HOST.x} y={HOST.top} w={HOST.w} h={HOST.h} title="Desktop app" at={OUT_AT + 10}>
          <div style={{ position: "absolute", inset: 0, padding: "30px 34px" }}>
            <div style={{ marginLeft: "auto", width: 210, height: 44, borderRadius: 16, background: "#F1F2F6" }} />
            <Bars widths={[330, 290, 180]} at={OUT_AT + 22} style={{ marginTop: 26 }} />
          </div>
        </Win>
        <Win x={HOST.x} y={HOST.bot} w={HOST.w} h={HOST.h} title="Command line" dark at={OUT_AT + 16}>
          <div style={{ position: "absolute", inset: 0, padding: "30px 34px", display: "flex", gap: 18 }}>
            <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 30, lineHeight: "18px", color: C.blue }}>›</span>
            <Bars widths={[300, 250, 160]} color="#34343A" at={OUT_AT + 28} />
          </div>
        </Win>

        <Say at={CAPTION} stagger={4} size={62} y={420} lines={[["The", "desktop", "app", "and", "the", "CLI", { t: "share", color: C.blue }, { t: "it.", color: C.blue }]]} />
      </Camera>
    </AbsoluteFill>
  );
};
