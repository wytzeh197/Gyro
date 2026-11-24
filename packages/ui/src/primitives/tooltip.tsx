import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { cx } from "./cx";

/** Gyro's hover delay. Adjacent tooltips open instantly within `timeout`. */
export const TOOLTIP_DELAY_MS = 450;

export interface TooltipProviderProps {
  children?: ReactNode;
  delay?: number;
  closeDelay?: number;
  timeout?: number;
}

/**
 * Shares one delay group across the app: once a tooltip is visible, moving
 * to a neighbour skips the delay.
 */
export function TooltipProvider({
  delay = TOOLTIP_DELAY_MS,
  closeDelay = 0,
  timeout = 400,
  children,
}: TooltipProviderProps) {
  return (
    <BaseTooltip.Provider
      delay={delay}
      closeDelay={closeDelay}
      timeout={timeout}
    >
      {children}
    </BaseTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The tooltip text. Empty content renders the trigger alone. */
  content: ReactNode;
  /** A single element that receives the trigger props. */
  children: ReactElement;
  side?: BaseTooltip.Positioner.Props["side"];
  align?: BaseTooltip.Positioner.Props["align"];
  sideOffset?: number;
  /** Keyboard hint shown after the text. */
  shortcut?: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * The one tooltip surface. `installGyroTooltips()` routes `title`
 * attributes through the same `.gyro-tip` styles.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  shortcut,
  className,
  disabled = false,
}: TooltipProps) {
  if (disabled || content == null || content === "" || !isValidElement(children)) {
    return children;
  }
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          className="gyro-tip-positioner"
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
        >
          <BaseTooltip.Popup className={cx("gyro-tip", className)}>
            <span className="gyro-tip__text">{content}</span>
            {shortcut ? (
              <span className="gyro-tip__shortcut">{shortcut}</span>
            ) : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
