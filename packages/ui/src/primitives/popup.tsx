import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown, ChevronRight } from "../icons";
import { forwardRef, useRef, type ReactNode } from "react";
import { cx, styledPart, withBaseClass } from "./cx";

/**
 * One floating surface for every menu, context menu, popover and select:
 * `.gyro-popup[data-kind]` on the elevated background with the popover
 * shadow. Items, separators, labels and shortcuts share one row spec.
 */
export type PopupKind = "menu" | "context" | "popover" | "select";

type PositionProps = Pick<
  BaseMenu.Positioner.Props,
  "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
>;

function positionProps(
  {
    side,
    align,
    sideOffset = 6,
    alignOffset,
    collisionPadding = 8,
  }: PositionProps,
  defaults: Pick<PositionProps, "side" | "align">,
): PositionProps {
  return {
    side: side ?? defaults.side,
    align: align ?? defaults.align,
    sideOffset,
    alignOffset,
    collisionPadding,
  };
}

/* ---------------------------------- Menu ---------------------------------- */

export interface MenuContentProps
  extends Omit<BaseMenu.Popup.Props, "className">, PositionProps {
  className?: string;
  /** Minimum popup width in px; defaults to the trigger's width. */
  minWidth?: number;
  /** Position against this instead of the trigger, e.g. a pointer point. */
  anchor?: BaseMenu.Positioner.Props["anchor"];
  /** Keep a menu inside a local container query or a scoped dock. */
  portalContainer?: BaseMenu.Portal.Props["container"];
}

const MenuContent = forwardRef<HTMLDivElement, MenuContentProps>(
  function MenuContent(
    {
      side,
      align,
      sideOffset,
      alignOffset,
      collisionPadding,
      className,
      minWidth,
      anchor,
      portalContainer,
      style,
      ...props
    },
    ref,
  ) {
    return (
      <BaseMenu.Portal container={portalContainer}>
        <BaseMenu.Positioner
          anchor={anchor}
          className="gyro-popup-positioner"
          {...positionProps(
            { side, align, sideOffset, alignOffset, collisionPadding },
            { side: "bottom", align: "start" },
          )}
        >
          <BaseMenu.Popup
            ref={ref}
            data-kind="menu"
            className={cx("gyro-popup", className)}
            style={minWidth ? { minWidth, ...style } : style}
            {...props}
          />
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    );
  },
);

export interface MenuItemProps extends Omit<BaseMenu.Item.Props, "className"> {
  className?: string;
  icon?: ReactNode;
  /** Keyboard hint, rendered right-aligned. */
  shortcut?: ReactNode;
  /** Destructive rows use the danger text tier. */
  tone?: "default" | "danger";
}

const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { icon, shortcut, tone = "default", className, children, ...props },
  ref,
) {
  return (
    <BaseMenu.Item
      ref={ref}
      className={cx("gyro-popup__item", className)}
      data-tone={tone === "danger" ? "danger" : undefined}
      {...props}
    >
      {icon ? <span className="gyro-popup__icon">{icon}</span> : null}
      <span className="gyro-popup__text">{children}</span>
      {shortcut ? (
        <span className="gyro-popup__shortcut">{shortcut}</span>
      ) : null}
    </BaseMenu.Item>
  );
});

export interface MenuCheckboxItemProps extends Omit<
  BaseMenu.CheckboxItem.Props,
  "className"
> {
  className?: string;
  shortcut?: ReactNode;
}

const MenuCheckboxItem = forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem({ shortcut, className, children, ...props }, ref) {
    return (
      <BaseMenu.CheckboxItem
        ref={ref}
        className={cx("gyro-popup__item", className)}
        {...props}
      >
        <BaseMenu.CheckboxItemIndicator
          className="gyro-popup__indicator"
          keepMounted
        >
          <Check aria-hidden size={14} />
        </BaseMenu.CheckboxItemIndicator>
        <span className="gyro-popup__text">{children}</span>
        {shortcut ? (
          <span className="gyro-popup__shortcut">{shortcut}</span>
        ) : null}
      </BaseMenu.CheckboxItem>
    );
  },
);

export interface MenuRadioItemProps extends Omit<
  BaseMenu.RadioItem.Props,
  "className"
> {
  className?: string;
}

const MenuRadioItem = forwardRef<HTMLDivElement, MenuRadioItemProps>(
  function MenuRadioItem({ className, children, ...props }, ref) {
    return (
      <BaseMenu.RadioItem
        ref={ref}
        className={cx("gyro-popup__item", className)}
        {...props}
      >
        <BaseMenu.RadioItemIndicator
          className="gyro-popup__indicator"
          keepMounted
        >
          <Check aria-hidden size={14} />
        </BaseMenu.RadioItemIndicator>
        <span className="gyro-popup__text">{children}</span>
      </BaseMenu.RadioItem>
    );
  },
);

export interface MenuSubmenuTriggerProps extends Omit<
  BaseMenu.SubmenuTrigger.Props,
  "className"
> {
  className?: string;
  icon?: ReactNode;
}

const MenuSubmenuTrigger = forwardRef<HTMLDivElement, MenuSubmenuTriggerProps>(
  function MenuSubmenuTrigger({ icon, className, children, ...props }, ref) {
    return (
      <BaseMenu.SubmenuTrigger
        ref={ref}
        className={cx("gyro-popup__item", className)}
        {...props}
      >
        {icon ? <span className="gyro-popup__icon">{icon}</span> : null}
        <span className="gyro-popup__text">{children}</span>
        <ChevronRight aria-hidden className="gyro-popup__chevron" size={14} />
      </BaseMenu.SubmenuTrigger>
    );
  },
);

const MenuSeparator = styledPart(
  BaseMenu.Separator,
  "gyro-popup__separator",
  "MenuSeparator",
);
const MenuGroupLabel = styledPart(
  BaseMenu.GroupLabel,
  "gyro-popup__label",
  "MenuGroupLabel",
);

export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Content: MenuContent,
  Item: MenuItem,
  LinkItem: styledPart(BaseMenu.LinkItem, "gyro-popup__item", "MenuLinkItem"),
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem: MenuRadioItem,
  Group: BaseMenu.Group,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
};

/** A zero-size anchor at a viewport point, for menus opened at the pointer. */
export function pointAnchor(x: number, y: number) {
  return {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  };
}

/* ------------------------------ Context menu ------------------------------ */

export interface ContextMenuContentProps extends Omit<
  BaseContextMenu.Popup.Props,
  "className"
> {
  className?: string;
}

const ContextMenuContent = forwardRef<HTMLDivElement, ContextMenuContentProps>(
  function ContextMenuContent({ className, ...props }, ref) {
    return (
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner
          className="gyro-popup-positioner"
          collisionPadding={8}
        >
          <BaseContextMenu.Popup
            ref={ref}
            data-kind="context"
            className={cx("gyro-popup", className)}
            {...props}
          />
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    );
  },
);

/** Opens at the pointer on right-click and clamps to the viewport. */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Content: ContextMenuContent,
  // Context menu items are Menu parts under the hood; reuse their row spec.
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem: MenuRadioItem,
  Group: BaseMenu.Group,
  GroupLabel: MenuGroupLabel,
  Separator: MenuSeparator,
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
};

/* --------------------------------- Popover -------------------------------- */

export interface PopoverContentProps
  extends Omit<BasePopover.Popup.Props, "className">, PositionProps {
  className?: string;
  /** Position against this element instead of the trigger (hover cards). */
  anchor?: BasePopover.Positioner.Props["anchor"];
  collisionBoundary?: BasePopover.Positioner.Props["collisionBoundary"];
  /** Keep the picker in the surrounding form's layout. */
  inline?: boolean;
}

const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      side,
      align,
      sideOffset,
      alignOffset,
      collisionPadding,
      collisionBoundary,
      inline = false,
      anchor,
      className,
      ...props
    },
    ref,
  ) {
    const inlineHost = useRef<HTMLDivElement>(null);
    return (
      <>
        {inline && <div ref={inlineHost} />}
        <BasePopover.Portal container={inline ? inlineHost : undefined}>
          <BasePopover.Positioner
            className={cx(
              "gyro-popup-positioner",
              inline && "gyro-popup-positioner--inline",
            )}
            anchor={anchor}
            collisionBoundary={collisionBoundary}
            style={inline ? { position: "static", transform: "none" } : undefined}
            {...positionProps(
              { side, align, sideOffset, alignOffset, collisionPadding },
              { side: "bottom", align: "center" },
            )}
          >
            <BasePopover.Popup
              ref={ref}
              data-kind="popover"
              className={cx("gyro-popup", className)}
              {...props}
            />
          </BasePopover.Positioner>
        </BasePopover.Portal>
      </>
    );
  },
);

export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Content: PopoverContent,
  Title: styledPart(BasePopover.Title, "gyro-popup__title", "PopoverTitle"),
  Description: styledPart(
    BasePopover.Description,
    "gyro-popup__description",
    "PopoverDescription",
  ),
  Close: BasePopover.Close,
};

/* --------------------------------- Select --------------------------------- */

export interface SelectTriggerProps extends Omit<
  BaseSelect.Trigger.Props,
  "className"
> {
  className?: string;
  placeholder?: ReactNode;
  size?: "sm" | "md";
}

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  function SelectTrigger(
    { placeholder, size = "md", className, children, ...props },
    ref,
  ) {
    return (
      <BaseSelect.Trigger
        ref={ref}
        className={cx("gyro-select-trigger", className)}
        data-size={size}
        {...props}
      >
        {children ?? (
          <BaseSelect.Value
            className="gyro-select-trigger__value"
            placeholder={placeholder}
          />
        )}
        <BaseSelect.Icon className="gyro-select-trigger__icon">
          <ChevronDown aria-hidden size={14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
    );
  },
);

export interface SelectContentProps extends Omit<
  BaseSelect.Popup.Props,
  "className"
> {
  className?: string;
  /**
   * Places the selected item over the trigger (macOS style). Off by default
   * so the list opens below like the other popups.
   */
  alignItemWithTrigger?: boolean;
}

const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(
  function SelectContent(
    { className, alignItemWithTrigger = false, children, ...props },
    ref,
  ) {
    return (
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="gyro-popup-positioner"
          alignItemWithTrigger={alignItemWithTrigger}
          sideOffset={6}
          collisionPadding={8}
        >
          <BaseSelect.Popup
            ref={ref}
            data-kind="select"
            className={cx("gyro-popup", className)}
            {...props}
          >
            <BaseSelect.List className="gyro-popup__list">
              {children}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    );
  },
);

export interface SelectItemProps extends Omit<
  BaseSelect.Item.Props,
  "className"
> {
  className?: string;
  /** Secondary line under the label, e.g. a model's provider. */
  description?: ReactNode;
}

const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
  function SelectItem({ description, className, children, ...props }, ref) {
    return (
      <BaseSelect.Item
        ref={ref}
        className={withBaseClass("gyro-popup__item", className)}
        {...props}
      >
        <BaseSelect.ItemIndicator className="gyro-popup__indicator" keepMounted>
          <Check aria-hidden size={14} />
        </BaseSelect.ItemIndicator>
        <span className="gyro-popup__text">
          <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
          {description ? (
            <span className="gyro-popup__description">{description}</span>
          ) : null}
        </span>
      </BaseSelect.Item>
    );
  },
);

export const Select = {
  Root: BaseSelect.Root,
  Trigger: SelectTrigger,
  Value: BaseSelect.Value,
  Content: SelectContent,
  Item: SelectItem,
  Group: BaseSelect.Group,
  GroupLabel: styledPart(
    BaseSelect.GroupLabel,
    "gyro-popup__label",
    "SelectGroupLabel",
  ),
  Separator: styledPart(
    BaseSelect.Separator,
    "gyro-popup__separator",
    "SelectSeparator",
  ),
};
