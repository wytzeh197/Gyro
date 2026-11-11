import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { SlashVignette } from "../scenes/SlashMenu";
import { At, Camera, Center, DARK_TEXT, DarkBg, LightBg, Words, depthIn, focusOut } from "../ui/motion";
import { C, display, inOut, prog } from "../ui/theme";

const UI_AT = 54; // vignette frame 0; it types "/" at its frame 14
const LAND = UI_AT + 14;
const FOCUS = 180;

export const SLASH_FRAMES = 264;

/** The "/" from the headline flies into the composer and becomes the typed character. */
const FlyingSlash: React.FC = () => {
  const frame = useCurrentFrame();
  const t = prog(frame, 48, LAND, inOut);
  const x = interpolate(t, [0, 1], [1262, 669]);
  const size = interpolate(t, [0, 1], [150, 51]);
  const color = t < 0.5 ? C.blue : C.ink;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 540,
        translate: "-50% -54%",
        fontFamily: display,
        fontWeight: 600,
        fontSize: size,
        lineHeight: 1,
        color,
        opacity: prog(frame, 12, 24) * (frame >= LAND ? 0 : 1),
        filter: `blur(${(1 - prog(frame, 12, 24)) * 20 + Math.sin(t * Math.PI) * 6}px)`,
      }}
    >
      /
    </div>
  );
};

export const SlashBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LightBg />
      <AbsoluteFill style={focusOut(frame, FOCUS)}>
        <Camera
          keys={[
            [LAND, 760, 874, 1.7],
            [96, 960, 545, 1.04],
            [112, 960, 545, 1.04],
            [138, 960, 470, 1.22],
            [FOCUS + 30, 960, 470, 1.28],
          ]}
        >
          <At x={550} y={150} w={820} h={780} style={depthIn(frame, UI_AT - 2, 14)}>
            <Sequence from={UI_AT} layout="none" name="Slash menu">
              <SlashVignette />
            </Sequence>
          </At>
        </Camera>
      </AbsoluteFill>

      {/* Dark opener that dissolves into the light UI as the slash lands. */}
      <AbsoluteFill style={{ opacity: 1 - prog(frame, 50, 68, inOut) }}>
        <DarkBg />
      </AbsoluteFill>
      <Center style={{ flexDirection: "row", gap: 0 }}>
        <Words words={["Just", "type"]} at={2} out={44} size={150} color={DARK_TEXT} />
        <span style={{ display: "inline-block", width: 120 }} />
      </Center>
      <FlyingSlash />

      <Center>
        <Words words={["Best", "match,"]} at={FOCUS + 6} size={112} />
        <Words words={[{ t: "first.", color: C.blue }]} at={FOCUS + 14} size={112} />
      </Center>
    </AbsoluteFill>
  );
};
