// Output-frame → story-frame maps. All UI, camera and pointer children share
// this clock, so deliberate pauses do not desynchronize clicks from the UI.
export type Timing = { keys: readonly (readonly [number, number])[]; duration: number };
type Band = readonly [until: number, outputFramesPerStoryFrame: number];
type Hold = readonly [at: number, outputFrames: number];

export const makeTiming = (bands: readonly Band[], holds: readonly Hold[] = []): Timing => {
  const end = bands[bands.length - 1][0];
  const stops = [...new Set([0, ...bands.map(([t]) => t), ...holds.map(([t]) => t)])].sort((a, b) => a - b);
  const keys: [number, number][] = [[0, 0]];
  let elapsed = 0;
  for (let i = 1; i < stops.length; i++) {
    const at = stops[i];
    if (at > end) throw new Error("Hold exceeds act duration");
    const band = bands.find(([until]) => until >= at)!;
    elapsed += (at - stops[i - 1]) * band[1];
    keys.push([elapsed, at]);
    const pause = holds.filter(([t]) => t === at).reduce((n, [, d]) => n + d, 0);
    if (pause) {
      elapsed += pause;
      keys.push([elapsed, at]);
    }
  }
  return { keys, duration: Math.ceil(elapsed) };
};

export const frameAt = (timing: Timing, frame: number) => {
  const keys = timing.keys;
  if (frame <= 0) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [b, y] = keys[i];
    if (frame <= b) {
      const [a, x] = keys[i - 1];
      return x + (y - x) * (frame - a) / (b - a);
    }
  }
  return keys[keys.length - 1][1];
};

export const workTiming = (duration: number) => makeTiming(
  [[90, 1.3], [150, 2.4], [300, 1.8], [340, 1.3], [430, 2.4], [duration, 1.3]],
  [[98, 10], [113, 15], [120, 12], [143, 10], [147, 10],
    [359, 8], [362, 8], [369, 8], [372, 8], [379, 8], [382, 8],
    [389, 8], [404, 10], [420, 10]],
);

export const nightTiming = (duration: number) => makeTiming(
  [[30, 1.3], [310, 2.15], [400, 1.3], [452, 1.9], [duration, 1.3]],
  [[55, 10], [74, 10], [111, 10], [168, 10], [187, 10], [205, 10], [243, 10]],
);
