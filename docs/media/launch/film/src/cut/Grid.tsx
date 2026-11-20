// 27–35s. Pull back from one pane while the rest tile in; one iso tilt; zoom through.
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ChatGridSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp } from "../app/GyroApp";
import { Camera, clamp } from "../ui/motion";
import { AppStage, Canvas, WordBuild } from "../ui/skale";
import { inOut } from "../ui/theme";
import { W, sessions } from "./data";
import { Pane } from "./Pane";

export const GRID = 240;
const TILE = [0, 30, 54, 76];

export const Grid: React.FC = () => {
  const f = useCurrentFrame();
  const count = TILE.filter((t) => f >= t).length;
  const layout = {
    projectKey: W,
    focusedPaneId: `pane-${count - 1}`,
    arrangement: count >= 3 ? ("grid" as const) : ("columns" as const),
    slots: Array.from({ length: 4 }, (_, i) => (i < count ? { paneId: `pane-${i}`, kind: "session" as const, sessionId: `s-${i}`, workspacePath: W } : null)),
  };
  const noop = () => undefined;
  // Tilt in over 110–170, hold, untilt 180–210.
  const tilt = interpolate(f, [110, 170, 180, 210], [0, 1, 1, 0], { ...clamp, easing: inOut });
  return (
    <AbsoluteFill>
      <Canvas />
      <AbsoluteFill style={{ perspective: 2400 }}>
        <AbsoluteFill style={{ transform: `rotateX(${tilt * 38}deg) rotateZ(${-tilt * 18}deg) scale(${1 - tilt * 0.18})`, transformStyle: "preserve-3d" }}>
          <Camera keys={[[0, 700, 540, 2.5], [24, 700, 540, 2.5], [96, 960, 540, 1.0], [220, 960, 540, 1.0], [240, 1340, 330, 3.2]]}>
            <AppStage>
              <GyroApp
                sessions={sessions}
                events={[]}
                content={
                  <ChatGridSurface
                    layout={layout as never}
                    onDropSession={() => false}
                    onFocusPane={noop}
                    onMovePane={() => false}
                    onToggleMaximize={noop}
                    renderPane={(pane: any, options: any) => {
                      const i = Number(pane.paneId.split("-")[1]);
                      return <Pane i={i} t={f - TILE[i]} options={options} />;
                    }}
                  />
                }
              />
            </AppStage>
          </Camera>
        </AbsoluteFill>
      </AbsoluteFill>
      <WordBuild words={["Tile", "everything."]} at={120} until={200} size={96} y={130} />
    </AbsoluteFill>
  );
};
