// 0–5s. A cursor blinks, then the promise builds word by word.
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Block, Canvas, WordBuild, ease } from "../ui/skale";
import { C } from "../ui/theme";
import { clamp } from "../ui/motion";

export const OPEN = 150;

export const Open: React.FC = () => {
  const f = useCurrentFrame();
  // The cursor sits alone, then hands off to the first word; it returns at the end, centred.
  const lone = f < 22 || f >= 136;
  const back = interpolate(f, [136, 146], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill>
      <Canvas />
      <WordBuild words={["One", "place", "for", "every", "agent"]} at={20} size={96} stagger={5} firstFrom={560} keyword={4} keyAt={100} until={130} trail />
      {lone && (
        <Block h={84} at={0} style={{ position: "absolute", left: 960 - 21, top: 540 - 42, opacity: f >= 136 ? back : undefined, background: C.blue }} />
      )}
    </AbsoluteFill>
  );
};
