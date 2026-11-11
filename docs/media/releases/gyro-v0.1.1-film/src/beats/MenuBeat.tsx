import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { MenuBarVignette } from "../scenes/MenuBar";
import { At, Camera, Center, LightBg, Words, focusOut } from "../ui/motion";
import { C } from "../ui/theme";

const UI_AT = 56; // vignette: popover drops at 16–36, click on Approve at 104
const FOCUS = 190;

export const MENU_FRAMES = 270;

export const MenuBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LightBg />
      <AbsoluteFill style={{ ...focusOut(frame, FOCUS), opacity: frame < UI_AT ? 0 : focusOut(frame, FOCUS).opacity }}>
        <Camera
          keys={[
            [UI_AT, 1110, 232, 2.6],
            [UI_AT + 14, 1110, 236, 2.5],
            [UI_AT + 40, 960, 470, 1.25],
            [UI_AT + 62, 960, 470, 1.25],
            [UI_AT + 92, 1060, 420, 1.55],
            [FOCUS + 30, 1060, 420, 1.62],
          ]}
        >
          <At x={550} y={200} w={820} h={520}>
            <Sequence from={UI_AT} layout="none" name="Menu bar">
              <MenuBarVignette />
            </Sequence>
          </At>
        </Camera>
      </AbsoluteFill>

      <Center>
        <Words words={["Answer", "from"]} at={2} out={48} size={120} />
        <Words words={["the", { t: "menu bar.", color: C.blue }]} at={10} out={50} size={120} />
      </Center>
      <Center>
        <Words words={["Approvals", "and", "questions,"]} at={FOCUS + 6} size={100} />
        <Words words={["one", { t: "click", color: C.blue }, "away."]} at={FOCUS + 16} size={100} />
      </Center>
    </AbsoluteFill>
  );
};
