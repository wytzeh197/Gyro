import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { Contrast } from "./scenes/Contrast";
import { Intro } from "./scenes/Intro";
import { MenuBar } from "./scenes/MenuBar";
import { Outro } from "./scenes/Outro";
import { Projects } from "./scenes/Projects";
import { Reliability } from "./scenes/Reliability";
import { SlashMenu } from "./scenes/SlashMenu";
import { UnderTheHood } from "./scenes/UnderTheHood";
import { inOut } from "./ui/theme";

const T = linearTiming({ durationInFrames: 15, easing: inOut });

/** Gyro 0.1.1 release film: 8 scenes, 7 × 15-frame transitions, 1080 frames. */
export const Film: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence durationInFrames={105}>
      <Intro />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={T} />
    <TransitionSeries.Sequence durationInFrames={165}>
      <Projects />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={T} />
    <TransitionSeries.Sequence durationInFrames={165}>
      <SlashMenu />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={T} />
    <TransitionSeries.Sequence durationInFrames={165}>
      <MenuBar />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={T} />
    <TransitionSeries.Sequence durationInFrames={165}>
      <Reliability />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={T} />
    <TransitionSeries.Sequence durationInFrames={120}>
      <Contrast />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={T} />
    <TransitionSeries.Sequence durationInFrames={180}>
      <UnderTheHood />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={T} />
    <TransitionSeries.Sequence durationInFrames={120}>
      <Outro />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
