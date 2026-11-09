import type { DictationController, DictationListener } from "@gyro-dev/ui";

type Update = { kind?: string; text?: string };
type Ports = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (callback: (update: Update) => void) => Promise<() => void>;
};

/** Serialize native ownership so an old start/stop cannot stop a newer mic. */
export function createDesktopDictation(ports: Ports): DictationController {
  let queue: Promise<unknown> = Promise.resolve();
  let active: {
    listener: DictationListener;
    unsubscribe?: () => void;
    abort: () => void;
    finishing: boolean;
    requested: boolean;
  } | null = null;
  const enqueue = (work: () => Promise<unknown>) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const stop = () => {
    const run = active;
    active = null;
    if (!run) return;
    run.listener.signal.removeEventListener("abort", run.abort);
    run.unsubscribe?.();
    if (run.requested)
      void enqueue(() => ports.invoke("stop_dictation")).catch(() => {});
  };
  return {
    stop,
    finish() {
      const run = active;
      if (!run || run.finishing) return;
      run.finishing = true;
      void enqueue(async () => {
        if (active !== run) return;
        await ports.invoke("stop_dictation", { finish: true });
      }).catch(() => {
        if (active !== run) return;
        stop();
        run.listener.onError(
          "Dictation stopped. Your words are kept in the draft.",
        );
      });
    },
    start(listener) {
      stop();
      if (listener.signal.aborted) return;
      const run = {
        listener,
        abort: () => {
          if (active === run) stop();
        },
        finishing: false,
        requested: false,
        unsubscribe: undefined as (() => void) | undefined,
      };
      active = run;
      listener.signal.addEventListener("abort", run.abort, { once: true });
      void enqueue(async () => {
        if (active !== run) return;
        const unsubscribe = await ports.listen((update) => {
          if (active !== run || listener.signal.aborted) return;
          const text = update.text ?? "";
          if (update.kind === "final" || update.kind === "error") {
            stop();
            if (update.kind === "final") listener.onFinal(text);
            else listener.onError(text || "Dictation stopped.");
          } else if (text) listener.onPartial(text);
        });
        if (active !== run) {
          unsubscribe();
          return;
        }
        run.unsubscribe = unsubscribe;
        run.requested = true;
        // start_dictation checks current macOS permissions itself.
        await ports.invoke("start_dictation");
        if (active === run && !run.finishing) listener.onStart?.();
      }).catch((error: unknown) => {
        if (active !== run) return;
        stop();
        const message =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : "";
        listener.onError(message.trim() || "Allow the microphone to dictate.");
      });
    },
  };
}
