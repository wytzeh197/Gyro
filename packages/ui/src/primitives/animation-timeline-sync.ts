/*
 * Ported from Synara (apps/web/src/lib/animationTimelineSync.ts).
 * MIT License, Copyright (c) 2026 T3 Tools Inc., Emanuele Di Pietro.
 * See THIRD_PARTY_NOTICES.md.
 */
import { useLayoutEffect, type RefObject } from "react";

/**
 * Pins every running CSS animation on `element` to the document timeline
 * origin, so stepped spinners mounted at different moments tick together.
 */
export function syncAnimationsToTimelineOrigin(element: Element | null): void {
  if (!element || typeof element.getAnimations !== "function") return;
  for (const animation of element.getAnimations({ subtree: true })) {
    try {
      animation.startTime = 0;
    } catch {
      // A detached or finished animation has no timeline to join.
    }
  }
}

export function useTimelineSynchronizedAnimations(
  ref: RefObject<Element | null>,
): void {
  useLayoutEffect(() => {
    syncAnimationsToTimelineOrigin(ref.current);
  }, [ref]);
}
