import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { ProjectsVignette } from "../scenes/Projects";
import { At, Camera, Center, LightBg, Words, depthIn, focusOut } from "../ui/motion";
import { C } from "../ui/theme";

const UI_AT = 36;
const FOCUS = 178;

export const PROJECTS_FRAMES = 246;

export const ProjectsBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LightBg />
      <AbsoluteFill style={focusOut(frame, FOCUS)}>
        <Camera
          keys={[
            [UI_AT, 810, 470, 1.6],
            [104, 810, 455, 1.45],
            [124, 1135, 755, 1.7],
            [FOCUS + 30, 1135, 765, 1.8],
          ]}
        >
          <At x={550} y={160} w={820} h={760} style={depthIn(frame, UI_AT, 24)}>
            <Sequence from={UI_AT} layout="none" name="Sidebar + branches">
              <ProjectsVignette />
            </Sequence>
          </At>
        </Camera>
      </AbsoluteFill>

      <Center>
        <Words words={["Chats", "stay", "with"]} at={2} out={32} size={110} />
        <Words words={["their", { t: "project.", color: C.blue }]} at={12} out={34} size={110} />
      </Center>
      <Center>
        <Words words={["Branches", "show"]} at={FOCUS + 6} size={104} />
        <Words words={["recent", { t: "activity.", color: C.blue }]} at={FOCUS + 14} size={104} />
      </Center>
    </AbsoluteFill>
  );
};
