// 14–19s. Ink. "Bring your own" + rotating CLIs, then pull back from the real CLI grid.
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { GyroApp } from "../app/GyroApp";
import { cli } from "../scenes/Probe";
import { Camera, clamp } from "../ui/motion";
import { AppStage, Canvas, Decode, MonoLabel, Rotator, blurIn, blurOut, ease, line } from "../ui/skale";
import { C } from "../ui/theme";
import { sessions } from "./data";

export const CLI = 150;
const APP_AT = 70;

export const Cli: React.FC = () => {
  const f = useCurrentFrame();
  const appIn = interpolate(f, [APP_AT, APP_AT + 12], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill>
      <Canvas color={C.ink} />
      {f >= APP_AT && (
        <div style={{ position: "absolute", inset: 0, opacity: appIn, filter: appIn < 1 ? `blur(${(1 - appIn) * 14}px)` : undefined }}>
          <Camera keys={[[APP_AT, 1034, 346, 2.2], [110, 960, 540, 1.0], [CLI, 930, 520, 1.04]]}>
            <AppStage>
              <GyroApp sessions={sessions} events={[]} className="film-grid4" chromeProps={{ activeWorkspaceLayout: "terminal-grid" } as never} content={cli(f - APP_AT + 30)} />
            </AppStage>
          </Camera>
          <MonoLabel text="CLAUDE CODE" at={112} x={430} y={70} />
          <MonoLabel text="CODEX" at={116} x={1210} y={70} />
          <MonoLabel text="GEMINI CLI" at={120} x={430} y={1010} />
          <MonoLabel text="YOUR OWN CLI" at={124} x={1210} y={1010} />
        </div>
      )}
      {f < 96 && (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", ...blurOut(f, 84) }}>
          <div style={{ display: "flex", gap: 28, fontFamily: line, fontWeight: 500, fontSize: 92, letterSpacing: "-0.03em", color: "#fff", lineHeight: 1 }}>
            <span style={blurIn(f, 4)}>Bring your own</span>
            <Rotator items={["Claude Code", "Codex", "Gemini CLI", "Kimi", "your own CLI."]} at={24} every={12} height={100} style={{ color: "#8FA0FF", minWidth: 560 }} />
          </div>
          <div style={{ marginTop: 34, fontFamily: "'Geist Mono', monospace", fontSize: 24, color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em" }}>
            <Decode text="THE AGENT YOU ALREADY USE" at={30} />
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
