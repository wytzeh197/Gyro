/** Local opt-in measurements; frame callbacks are opportunities, not hardware paint. */
export type TimingSurface =
  | "chat"
  | "terminal"
  | "explorer"
  | "search"
  | "source-control"
  | "run-test"
  | "ai"
  | "tools"
  | "settings"
  | "automations"
  | "providers"
  | "onboarding";

export type SurfaceTiming = {
  kind: "startup" | "navigation";
  from: TimingSurface | null;
  surface: TimingSurface;
  startedToCommitMs: number;
  startedToFrameOpportunityMs: number;
};

type Sample = {
  kind: SurfaceTiming["kind"];
  from: TimingSurface | null;
  surface: TimingSurface;
  started: number;
  committed?: number;
};

export function createSurfaceTiming(options: {
  now: () => number;
  frame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  visible: () => boolean;
  save: (value: SurfaceTiming) => void;
  firstCommit: { at: number; surface: TimingSurface };
}) {
  let enabled: boolean | undefined;
  let disposed = false;
  let current = options.firstCommit.surface;
  let startup: Sample | undefined = {
    kind: "startup",
    from: null,
    surface: current,
    started: 0,
    committed: options.firstCommit.at,
  };
  let navigation: Sample | undefined;
  const frames = new Set<number>();
  const cancel = () => {
    for (const id of frames) options.cancelFrame(id);
    frames.clear();
  };
  const active = (sample: Sample) =>
    !disposed &&
    enabled &&
    options.visible() &&
    current === sample.surface &&
    (sample.kind === "startup" ? startup === sample : navigation === sample);
  const discard = (sample: Sample) => {
    if (startup === sample) startup = undefined;
    if (navigation === sample) navigation = undefined;
  };
  const frame = (callback: () => void) => {
    const id = options.frame(() => {
      frames.delete(id);
      callback();
    });
    frames.add(id);
  };
  const schedule = (sample: Sample) => {
    if (!active(sample)) {
      discard(sample);
      return;
    }
    frame(() => {
      if (!active(sample)) {
        discard(sample);
        return;
      }
      frame(() => {
        if (!active(sample)) {
          discard(sample);
          return;
        }
        discard(sample);
        options.save({
          kind: sample.kind,
          from: sample.from,
          surface: sample.surface,
          startedToCommitMs: Math.max(0, sample.committed! - sample.started),
          startedToFrameOpportunityMs: Math.max(
            0,
            options.now() - sample.started,
          ),
        });
      });
    });
  };
  return {
    enable(value: boolean) {
      if (disposed || enabled === value) return;
      enabled = value;
      if (!value) {
        cancel();
        startup = undefined;
        navigation = undefined;
      } else if (startup) schedule(startup);
    },
    isEnabled() {
      return enabled === true && !disposed;
    },
    begin(from: TimingSurface, surface: TimingSurface) {
      if (disposed || enabled !== true) return;
      cancel();
      startup = undefined;
      navigation = undefined;
      if (from !== surface && options.visible())
        navigation = {
          kind: "navigation",
          from,
          surface,
          started: options.now(),
        };
    },
    commit(surface: TimingSurface) {
      current = surface;
      if (
        disposed ||
        enabled !== true ||
        !navigation ||
        navigation.committed !== undefined
      )
        return;
      if (surface === navigation.surface) {
        navigation.committed = options.now();
        schedule(navigation);
      } else if (surface !== navigation.from) {
        cancel();
        navigation = undefined;
      }
    },
    dispose() {
      disposed = true;
      cancel();
      startup = undefined;
      navigation = undefined;
    },
  };
}
