import {
  cloneElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { playSurfaceTimeline, surfaceExitRate } from "./surface-motion";

type SurfaceProps = {
  ref?: Ref<HTMLElement>;
  "aria-hidden"?: boolean | "true" | "false";
};
type SurfaceElement = ReactElement<SurfaceProps> & { ref?: Ref<HTMLElement> };

/** Keep the currently painted surface until its original entrance runs backward. */
export function SurfacePresence({
  children,
  descendants = false,
  portal,
}: {
  children: SurfaceElement | null | false | undefined;
  descendants?: boolean;
  portal?: Element | DocumentFragment | "body" | null;
}) {
  const open = Boolean(children);
  const lastChild = useRef<SurfaceElement>();
  const [retained, setRetained] = useState(open);
  const child = children || (retained ? lastChild.current : undefined);
  const node = useRef<HTMLElement | null>(null);
  const originalRef = child?.ref;
  const attach = useCallback(
    (element: HTMLElement | null) => {
      node.current = element;
      if (typeof originalRef === "function") originalRef(element);
      else if (originalRef) {
        (originalRef as { current: HTMLElement | null }).current = element;
      }
    },
    [originalRef],
  );
  const tracks = useRef<Animation[]>([]);
  const previous = useRef<{ element: HTMLElement; open: boolean }>();

  useLayoutEffect(() => {
    if (children) {
      lastChild.current = children;
      setRetained(true);
    }
  }, [children]);

  const childType = child?.type;
  const childKey = child?.key;
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    element.inert = !open;
    element.toggleAttribute("data-surface-presence", true);
    element.toggleAttribute("data-surface-exit", !open);
    const sameSurface = previous.current?.element === element;
    const wasClosing = sameSurface && !previous.current?.open;
    previous.current = { element, open };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const entrances = () =>
      element.getAnimations?.({ subtree: descendants }).filter((animation) => {
        const name = (animation as CSSAnimation).animationName;
        const effect = animation.effect as KeyframeEffect | null;
        return Boolean(
          name &&
          /(?:-in(?:-|$)|-enter$)/.test(name) &&
          effect?.target?.closest("[data-surface-presence]") === element &&
          Number.isFinite(effect.getComputedTiming().endTime),
        );
      }) ?? [];

    if (open) {
      if (reduced.matches) {
        tracks.current = [];
      } else if (wasClosing) {
        for (const animation of tracks.current) {
          if (!animation.effect || animation.playState === "idle") continue;
          playSurfaceTimeline(animation, 1);
        }
      } else {
        tracks.current = entrances();
        for (const animation of tracks.current) {
          animation.effect?.updateTiming({ fill: "both" });
        }
      }
      return;
    }

    const finish = () => {
      lastChild.current = undefined;
      setRetained(false);
    };
    // A model picker can switch its CSS entrance when placement is resolved.
    const active =
      sameSurface && !reduced.matches
        ? [...new Set([...tracks.current, ...entrances()])].filter(
            (animation) =>
              animation.playState !== "idle" &&
              typeof animation.currentTime === "number" &&
              animation.currentTime > 0,
          )
        : [];
    if (!active.length) {
      finish();
      return;
    }
    const rate = surfaceExitRate(element);
    let exiting = true;
    const complete = () => {
      if (exiting) finish();
    };
    const remaining = Math.max(
      ...active.map((animation) => Number(animation.currentTime) / rate),
    );
    tracks.current = active;
    for (const animation of active) {
      animation.effect?.updateTiming({ fill: "both" });
      playSurfaceTimeline(animation, -rate);
    }
    void Promise.allSettled(active.map((animation) => animation.finished)).then(
      complete,
    );
    const deadline = window.setTimeout(complete, remaining + 100);
    const onReduce = () => {
      if (reduced.matches) complete();
    };
    reduced.addEventListener("change", onReduce);
    return () => {
      exiting = false;
      window.clearTimeout(deadline);
      reduced.removeEventListener("change", onReduce);
    };
  }, [open, childType, childKey, descendants, portal]);

  if (!child) return null;
  const surface = cloneElement(child, {
    ref: attach,
    "aria-hidden": open ? child.props["aria-hidden"] : true,
  });
  const target = portal === "body" ? document.body : portal;
  return target ? createPortal(surface, target) : surface;
}
