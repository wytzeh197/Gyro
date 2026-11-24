import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { ChevronRight } from "../icons";
import { forwardRef, type ReactNode } from "react";
import { cx, styledPart } from "./cx";

/**
 * Structure primitives: tabs, collapsible sections, scroll areas, dividers.
 *
 * The disclosure motion (a 220ms grid-rows 0fr to 1fr reveal with the chevron
 * turning 90 degrees) follows Synara (MIT, © 2026 T3 Tools Inc., Emanuele Di
 * Pietro). See THIRD_PARTY_NOTICES.md.
 */

export const Tabs = {
  Root: styledPart(BaseTabs.Root, "gyro-tabs", "Tabs"),
  List: styledPart(BaseTabs.List, "gyro-tabs__list", "TabsList"),
  Tab: styledPart(BaseTabs.Tab, "gyro-tabs__tab", "TabsTab"),
  Indicator: styledPart(
    BaseTabs.Indicator,
    "gyro-tabs__indicator",
    "TabsIndicator",
  ),
  Panel: styledPart(BaseTabs.Panel, "gyro-tabs__panel", "TabsPanel"),
};

export interface DisclosureProps
  extends Omit<BaseCollapsible.Root.Props, "className" | "title"> {
  className?: string;
  title: ReactNode;
  /** Text after the title, such as a count. */
  meta?: ReactNode;
  /** Icon before the title. Replaced by the chevron when `chevron` is "leading". */
  icon?: ReactNode;
  chevron?: "leading" | "trailing";
}

/** A titled section that folds its content away. */
export const Disclosure = forwardRef<HTMLDivElement, DisclosureProps>(
  function Disclosure(
    { className, title, meta, icon, chevron = "leading", children, ...props },
    ref,
  ) {
    const chevronNode = (
      <ChevronRight aria-hidden size={14} className="gyro-disclosure__chevron" />
    );
    return (
      <BaseCollapsible.Root
        ref={ref}
        className={cx("gyro-disclosure", className)}
        {...props}
      >
        <BaseCollapsible.Trigger className="gyro-disclosure__trigger">
          {chevron === "leading" ? chevronNode : null}
          {icon ? <span className="gyro-disclosure__icon">{icon}</span> : null}
          <span className="gyro-disclosure__title">{title}</span>
          {meta ? <span className="gyro-disclosure__meta">{meta}</span> : null}
          {chevron === "trailing" ? chevronNode : null}
        </BaseCollapsible.Trigger>
        <BaseCollapsible.Panel
          className="gyro-disclosure__panel"
          keepMounted
        >
          <div className="gyro-disclosure__clip">
            <div className="gyro-disclosure__content">{children}</div>
          </div>
        </BaseCollapsible.Panel>
      </BaseCollapsible.Root>
    );
  },
);

export interface ScrollAreaProps
  extends Omit<BaseScrollArea.Root.Props, "className"> {
  className?: string;
  viewportClassName?: string;
  orientation?: "vertical" | "horizontal" | "both";
}

/** A scroll container with a slim overlay scrollbar. */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  function ScrollArea(
    {
      className,
      viewportClassName,
      orientation = "vertical",
      children,
      ...props
    },
    ref,
  ) {
    return (
      <BaseScrollArea.Root
        ref={ref}
        className={cx("gyro-scroll-area", className)}
        {...props}
      >
        <BaseScrollArea.Viewport
          className={cx("gyro-scroll-area__viewport", viewportClassName)}
        >
          {children}
        </BaseScrollArea.Viewport>
        {orientation !== "horizontal" ? (
          <BaseScrollArea.Scrollbar
            orientation="vertical"
            className="gyro-scroll-area__bar"
          >
            <BaseScrollArea.Thumb className="gyro-scroll-area__thumb" />
          </BaseScrollArea.Scrollbar>
        ) : null}
        {orientation !== "vertical" ? (
          <BaseScrollArea.Scrollbar
            orientation="horizontal"
            className="gyro-scroll-area__bar"
          >
            <BaseScrollArea.Thumb className="gyro-scroll-area__thumb" />
          </BaseScrollArea.Scrollbar>
        ) : null}
        <BaseScrollArea.Corner />
      </BaseScrollArea.Root>
    );
  },
);

export const Separator = styledPart(
  BaseSeparator,
  "gyro-separator",
  "Separator",
);
