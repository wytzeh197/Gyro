import { AbsoluteFill, Series } from "remotion";
import { Dir, Grain, Whip } from "./ui/motion";
import { BRANCHES_FRAMES, BranchesBeat } from "./beats/BranchesBeat";
import { IDLE_FRAMES, IdleBeat } from "./beats/IdleBeat";
import { REBUILD_FRAMES, RebuildBeat } from "./beats/RebuildBeat";
import { RUNTIME_FRAMES, RuntimeBeat } from "./beats/RuntimeBeat";
import { STATS_FRAMES, StatsBeat } from "./beats/StatsBeat";
import { MENU_FRAMES, MenuBeat } from "./beats/MenuBeat";
import { OPEN_FRAMES, Open } from "./beats/Open";
import { OUTRO_FRAMES, OutroBeat } from "./beats/OutroBeat";
import { READABILITY_FRAMES, ReadabilityBeat } from "./beats/ReadabilityBeat";
import { RELIABILITY_FRAMES, ReliabilityBeat } from "./beats/ReliabilityBeat";
import { SLASH_FRAMES, SlashBeat } from "./beats/SlashBeat";

export const BEATS = [
  { id: "Open", component: Open, frames: OPEN_FRAMES },
  { id: "BranchesBeat", component: BranchesBeat, frames: BRANCHES_FRAMES },
  { id: "SlashBeat", component: SlashBeat, frames: SLASH_FRAMES },
  { id: "MenuBeat", component: MenuBeat, frames: MENU_FRAMES },
  { id: "ReliabilityBeat", component: ReliabilityBeat, frames: RELIABILITY_FRAMES },
  { id: "ReadabilityBeat", component: ReadabilityBeat, frames: READABILITY_FRAMES },
  { id: "RebuildBeat", component: RebuildBeat, frames: REBUILD_FRAMES },
  { id: "StatsBeat", component: StatsBeat, frames: STATS_FRAMES },
  { id: "RuntimeBeat", component: RuntimeBeat, frames: RUNTIME_FRAMES },
  { id: "IdleBeat", component: IdleBeat, frames: IDLE_FRAMES },
  { id: "OutroBeat", component: OutroBeat, frames: OUTRO_FRAMES },
] as const;

export const FILM2_FRAMES = BEATS.reduce((n, b) => n + b.frames, 0);

/**
 * Whip pans between beats, keyed by the beat they leave. Beats left out cut
 * hard, which keeps the slams in the backend chapter punchy.
 */
const WHIPS: Partial<Record<(typeof BEATS)[number]["id"], Dir>> = {
  Open: "left",
  BranchesBeat: "up",
  SlashBeat: "left",
  MenuBeat: "up",
  ReliabilityBeat: "left",
  ReadabilityBeat: "up",
  RebuildBeat: "left",
  StatsBeat: "up",
  RuntimeBeat: "left",
  IdleBeat: "up",
};

export const Film2: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
    <Series>
      {BEATS.map(({ id, component: Beat, frames }, i) => {
        const prev = i > 0 ? BEATS[i - 1].id : undefined;
        return (
          <Series.Sequence key={id} durationInFrames={frames} name={id}>
            <Whip frames={frames} exit={WHIPS[id]} enter={prev ? WHIPS[prev] : undefined}>
              <Beat />
            </Whip>
          </Series.Sequence>
        );
      })}
    </Series>
    <Grain opacity={0.06} />
  </AbsoluteFill>
);
