// 35–41s. Crop on the paused automation, switch it on, pull back to the list.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AutomationsSurface } from "@gyro-ui/surfaces.tsx";
import { GyroApp } from "../app/GyroApp";
import { Camera } from "../ui/motion";
import { AppStage, Canvas, Pointer, WordBuild } from "../ui/skale";
import { automations, sessions } from "./data";

export const AUTOMATIONS = 180;
const FLIP = 40;
const PILL: [number, number] = [1546, 566];

export const Automations: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Canvas />
      <Camera keys={[[0, PILL[0] - 80, PILL[1], 2.2], [56, PILL[0] - 80, PILL[1], 2.2], [96, 960, 540, 1.0], [130, 960, 495, 0.68], [AUTOMATIONS, 960, 490, 0.66]]}>
        <AppStage>
          <GyroApp
            sessions={sessions}
            events={[]}
            chromeProps={{ activeDestination: "automations" } as never}
            content={<AutomationsSurface automations={automations(f + 40, FLIP + 40) as never} selectedAutomationId="nightly-deps" />}
          />
        </AppStage>
        <Pointer keys={[[10, PILL[0] + 160, PILL[1] + 110], [FLIP - 4, PILL[0], PILL[1]]]} clicks={[FLIP - 2]} at={10} until={70} />
      </Camera>
      <WordBuild words={["Automate", "the", "rest."]} at={104} size={84} y={110} keyword={0} keyAt={140} />
    </AbsoluteFill>
  );
};
