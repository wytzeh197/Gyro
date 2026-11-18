import { Composition } from "remotion";
import { AppTest } from "./scenes/AppTest";
import { Probe } from "./scenes/Probe";
import { Measure } from "./scenes/Measure";
import { Film, FILM } from "./Film";

export const RemotionRoot = () => (
  <>
    <Composition id="Film" component={Film} durationInFrames={FILM} fps={30} width={1920} height={1080} />
    <Composition id="AppTest" component={AppTest} durationInFrames={90} fps={30} width={1920} height={1080} />
    <Composition id="Probe" component={Probe} durationInFrames={30} fps={30} width={1920} height={1080} defaultProps={{ view: "cli" }} />
    <Composition id="Measure" component={Measure} durationInFrames={1} fps={30} width={1920} height={1080} defaultProps={{ view: "chat" }} />
  </>
);
