// 5–14s. The cursor becomes the composer. Ask, pick a model, send, watch, approve.
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { GyroApp } from "../app/GyroApp";
import { Camera, clamp } from "../ui/motion";
import { AppStage, Canvas, Glow, Keycap, MorphRect, Pointer, SelectionBox, WordBuild, appPt, ease } from "../ui/skale";
import { ASK, MODELS, approval, plan, reply, sessions, steps, userMsg } from "./data";

export const CHAT = 270;
const TYPE = 24; // typing starts
const SEND = 86;
const STEP0 = 100;
const ASK_AT = 150;
const APPROVE = 192;
const REPLY = 206;

const composer = appPt(757, 722);
const chip = appPt(915, 770);
const card = appPt(687, 345);
const run = appPt(924, 427);

export const Chat: React.FC = () => {
  const f = useCurrentFrame();
  const sent = f >= SEND;
  const typed = sent ? "" : ASK.slice(0, Math.max(0, Math.floor((f - TYPE) * 2)));
  const shown = sent ? Math.max(0, Math.min(steps.length, Math.floor((f - STEP0) / 12) + 1)) : 0;
  const events = sent
    ? [userMsg, ...steps.slice(0, f >= STEP0 ? shown : 0), ...(f >= ASK_AT ? [approval(f >= APPROVE ? "approved" : "pending")] : []), ...(f >= REPLY ? [reply] : [])]
    : [];
  const model = MODELS[f < 64 ? 0 : f < 72 ? 1 : f < 80 ? 2 : 0];
  // Caret position for tracking: composer text starts ~app x 390.
  const caretX = appPt(390 + typed.length * 7.6, 0)[0];
  const appIn = interpolate(f, [12, 24], [0, 1], { ...clamp, easing: ease });
  const cam: [number, number, number, number][] = [
    [0, composer[0], 900, 1.6],
    [TYPE + 4, composer[0], 900, 1.6],
    [TYPE + 30, Math.min(1180, caretX), 920, 1.6],
    [56, 1180, 940, 1.6],
    [SEND + 4, 1180, 940, 1.6],
    [126, 960, 540, 1.0],
    [ASK_AT + 2, 960, 540, 1.0],
    [ASK_AT + 26, card[0] + 60, card[1] + 20, 1.8],
    [APPROVE + 12, card[0] + 60, card[1] + 20, 1.8],
    [240, 960, 323, 0.62],
  ];
  return (
    <AbsoluteFill>
      <Canvas />
      <Camera keys={cam}>
        <div style={{ opacity: appIn }}>
          <AppStage>
            <GyroApp
              sessions={sessions}
              events={events as never}
              draft={typed}
              elapsedMs={sent ? ((f - SEND) * 1000) / 30 * 6 : 0}
              chatProps={{ sessionModel: { ...sessions[0], ...model }, sessionPlan: sent ? plan(Math.min(3, shown)) : undefined, isComposerSending: sent && f < REPLY }}
            />
          </AppStage>
        </div>
        <Glow x={composer[0]} y={composer[1]} at={SEND} r={520} />
        <SelectionBox x={card[0] - 420} y={card[1] - 160} w={840} h={320} at={ASK_AT + 20} until={APPROVE + 10} label="APPROVAL · gh pr create" />
        <Pointer
          keys={[[44, chip[0] + 120, chip[1] - 120], [60, chip[0], chip[1] - 4], [82, chip[0], chip[1] - 4], [ASK_AT + 26, run[0] + 140, run[1] + 120], [APPROVE - 6, run[0], run[1]]]}
          clicks={[62, 70, 78, APPROVE - 4]}
          at={44}
          until={APPROVE + 18}
        />
      </Camera>
      {/* Screen space: the cursor stretches into the composer. */}
      <MorphRect from={[960, 540, 42, 84]} to={[960, 644, 1555, 266]} at={0} len={18} fill="#ffffff" fadeAt={16} fromRadius={5} toRadius={28} />
      <Keycap keys={["⌘", "↵"]} at={72} press={SEND - 2} until={SEND + 10} x={960} y={300} size={84} />
      <WordBuild words={["You", "approve", "what", "runs."]} at={226} size={80} y={150} until={262} />
    </AbsoluteFill>
  );
};
