import { Composition, Folder } from "remotion";
import { Film } from "./Film";
import { BEATS, FILM2_FRAMES, Film2 } from "./Film2";
import { Contrast } from "./scenes/Contrast";
import { Intro } from "./scenes/Intro";
import { MenuBar } from "./scenes/MenuBar";
import { Outro } from "./scenes/Outro";
import { Projects } from "./scenes/Projects";
import { Reliability } from "./scenes/Reliability";
import { SlashMenu } from "./scenes/SlashMenu";
import { UnderTheHood } from "./scenes/UnderTheHood";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="GyroV011" component={Film2} durationInFrames={FILM2_FRAMES} fps={30} width={1920} height={1080} />
      <Composition id="GyroV011Classic" component={Film} durationInFrames={1080} fps={30} width={1920} height={1080} />
      <Folder name="Beats">
        {BEATS.map((b) => (
          <Composition key={b.id} id={b.id} component={b.component} durationInFrames={b.frames} fps={30} width={1920} height={1080} />
        ))}
      </Folder>
      <Folder name="Scenes">
        <Composition id="Intro" component={Intro} durationInFrames={105} fps={30} width={1920} height={1080} />
        <Composition id="Projects" component={Projects} durationInFrames={165} fps={30} width={1920} height={1080} />
        <Composition id="SlashMenu" component={SlashMenu} durationInFrames={165} fps={30} width={1920} height={1080} />
        <Composition id="MenuBar" component={MenuBar} durationInFrames={165} fps={30} width={1920} height={1080} />
        <Composition id="Reliability" component={Reliability} durationInFrames={165} fps={30} width={1920} height={1080} />
        <Composition id="Contrast" component={Contrast} durationInFrames={120} fps={30} width={1920} height={1080} />
        <Composition id="UnderTheHood" component={UnderTheHood} durationInFrames={180} fps={30} width={1920} height={1080} />
        <Composition id="Outro" component={Outro} durationInFrames={120} fps={30} width={1920} height={1080} />
      </Folder>
    </>
  );
};
