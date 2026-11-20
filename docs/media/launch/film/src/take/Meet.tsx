// "Meet Gyro" on white, straight out of the lifted send arrow.
import { AbsoluteFill } from "remotion";
import { TypeCard } from "./kit";

export const MEET = 120;
export const Meet: React.FC = () => (
  <AbsoluteFill style={{ background: "#fff" }}>
    <TypeCard text="Meet Gyro" at={0} cps={0.3} del={92} until={MEET} caretUntil={MEET - 4} size={150} />
  </AbsoluteFill>
);
