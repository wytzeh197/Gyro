// Gyro launch film, ~72s. One continuous take on a Mac desktop, cut to 96 BPM (a beat every 18.75 frames).
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { Grain } from "./ui/motion";
import { Pace } from "./pace";
import { Open, OPEN } from "./take/Open";
import { Meet, MEET } from "./take/Meet";
import { Apps, APPS } from "./take/Apps";
import { Ship, SHIP } from "./take/Ship";
import { Work, WORK } from "./take/Work";
import { Night, NIGHT } from "./take/Night";
import { nightTiming, workTiming, type Timing } from "./timing";

// Each act hands off on a matching frame (white, the green wipe), so there are no crossfades.
// Everything after the bin plays at the same unhurried pace as the opening acts.
const SLOW = 1.3;
const workPace = workTiming(WORK);
const nightPace = nightTiming(NIGHT);
const acts: { C: React.FC; d: number; s?: number; timing?: Timing }[] = [
  { C: Open, d: OPEN },
  { C: Meet, d: MEET },
  { C: Apps, d: APPS },
  { C: Ship, d: Math.round(SHIP * SLOW), s: SLOW },
  { C: Work, d: workPace.duration, timing: workPace },
  { C: Night, d: nightPace.duration, timing: nightPace },
];

export const BEAT_STARTS = acts.reduce<number[]>((a, _, i) => [...a, i ? a[i - 1] + acts[i - 1].d : 0], []);
export const FILM = BEAT_STARTS[acts.length - 1] + acts[acts.length - 1].d;

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  // Keep fine UI text clean during Work; other acts retain their original grain.
  const inWork = frame >= BEAT_STARTS[4] && frame < BEAT_STARTS[5];
  return (
  <AbsoluteFill style={{ background: "#F5F5F8" }}>
    {acts.map(({ C, d, s = 1, timing }, i) => (
      <Sequence key={i} from={BEAT_STARTS[i]} durationInFrames={d} premountFor={30}>
        <Pace speed={s} timing={timing}>
          <C />
        </Pace>
      </Sequence>
    ))}
    <Grain opacity={inWork ? 0 : 0.03} />
  </AbsoluteFill>
  );
};
