import { useLayoutEffect, useRef, useState } from "react";

import { chatEnvironmentRestsBesideColumn } from "./chat-companion";
import type { ChatSidePanelId } from "./types";

function cssPixels(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed.endsWith("px")) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether a chat surface is wide enough for the Environment card to rest open
 * beside its conversation column. Both widths come from the surface's own
 * styles (`--gyro-chat-content-width` and `--gyro-environment-card-space`), so
 * the numbers stay next to the CSS that draws the column and the card. It is
 * measured before paint and again whenever the surface resizes; until then,
 * and without the space property, the card counts as not fitting, which keeps
 * it closed rather than covering the transcript.
 */
function useChatEnvironmentRests(
  surface: HTMLElement | null,
  isActive: boolean,
) {
  const [rests, setRests] = useState(false);
  useLayoutEffect(() => {
    if (!isActive || !surface) return;
    const measure = () => {
      const style = getComputedStyle(surface);
      const space = cssPixels(
        style.getPropertyValue("--gyro-environment-card-space"),
      );
      setRests(
        space !== undefined &&
          chatEnvironmentRestsBesideColumn({
            columnWidth: cssPixels(
              style.getPropertyValue("--gyro-chat-content-width"),
            ),
            space,
            surfaceWidth: surface.clientWidth,
          }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [isActive, surface]);
  return rests;
}

/**
 * The Environment card of one chat thread. The card floats over the chat.
 * Where the surface leaves room beside the conversation column it rests open
 * as the rail's resting state, and its button and close control withdraw or
 * restore that state as before. Anywhere narrower it would sit on the
 * transcript's text and turn actions, so it stays closed until its button
 * opens it as a popover; switching to another chat closes it, and the caller
 * closes it on Escape or a click outside while `isPopover` is true.
 */
export function useChatEnvironmentPopover(options: {
  activeRailPanel?: ChatSidePanelId;
  isCompanionPanel: boolean;
  isEmptyStart: boolean;
  onToggleEnvironmentRail?: () => void;
  paneKey: string;
}) {
  const {
    activeRailPanel,
    isCompanionPanel,
    isEmptyStart,
    onToggleEnvironmentRail,
    paneKey,
  } = options;
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rests = useChatEnvironmentRests(surface, !isEmptyStart);
  // Keyed by chat, so the popover never follows the user into another one.
  const [openPaneKey, setOpenPaneKey] = useState<string>();
  const isRailFree =
    !isCompanionPanel &&
    (activeRailPanel === undefined || activeRailPanel === "environment");
  const isOpen =
    !isEmptyStart &&
    (rests
      ? activeRailPanel === "environment" && !isCompanionPanel
      : isRailFree && openPaneKey === paneKey);
  const dismiss = () => setOpenPaneKey(undefined);
  return {
    buttonRef,
    dismiss,
    isOpen,
    isPopover: isOpen && !rests,
    setSurface,
    close: () => {
      if (rests) onToggleEnvironmentRail?.();
      else dismiss();
      buttonRef.current?.focus();
    },
    toggle: () => {
      if (rests) onToggleEnvironmentRail?.();
      else if (isOpen) dismiss();
      else {
        // Another panel holds the rail: hand it back first, as the resting
        // toggle does, so the popover is not hidden behind it.
        if (!isRailFree) onToggleEnvironmentRail?.();
        setOpenPaneKey(paneKey);
      }
    },
  };
}
