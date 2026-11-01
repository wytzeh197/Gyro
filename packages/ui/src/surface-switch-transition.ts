import { flushSync } from "react-dom";

/* Crossfades the Sessions <-> Workspace swap instead of blanking the window.
   Without it the old surface unmounts on the spot and the new one fades up
   from nothing while the shell columns slide, which reads as a blink. The
   data attribute names the sidebar, main pane and switch for the transition
   and pauses the shell's own tweens (see interaction-motion.css), so the
   browser blends two settled layouts. WebViews without view transitions, and
   reduced motion, apply the change directly. */
let activeTransition: ViewTransition | undefined;

export function runSurfaceSwitch(apply: () => void) {
  const root = document.documentElement;
  if (
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    apply();
    return;
  }
  root.dataset.surfaceSwitch = "";
  const transition = document.startViewTransition(() => {
    flushSync(apply);
  });
  // A quick second click skips the running transition; that is expected.
  activeTransition = transition;
  transition.ready.catch(() => undefined);
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      // The skipped transition must not clear the one that replaced it.
      if (activeTransition === transition) {
        activeTransition = undefined;
        delete root.dataset.surfaceSwitch;
      }
    });
}
