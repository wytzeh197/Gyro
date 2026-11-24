import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "../icons";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { IconButton } from "./button";
import { cx, styledPart } from "./cx";

/**
 * Modal surfaces: `.gyro-dialog` on the elevated background with the dialog
 * shadow, over a 60% black backdrop. Opens and closes with a .98 scale and a
 * fade over 200ms; a nested dialog shrinks and lifts its parent.
 */
export type DialogSize = "sm" | "md" | "lg";

export interface DialogContentProps
  extends Omit<BaseDialog.Popup.Props, "className"> {
  className?: string;
  size?: DialogSize;
  /** Renders a close button in the top-right corner. */
  showClose?: boolean;
  closeLabel?: string;
  viewportClassName?: string;
}

const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent(
    {
      className,
      size = "md",
      showClose = false,
      closeLabel = "Close",
      viewportClassName,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="gyro-dialog-backdrop" />
        <BaseDialog.Viewport className={cx("gyro-dialog-viewport", viewportClassName)}>
          <BaseDialog.Popup
            ref={ref}
            className={cx("gyro-dialog", className)}
            data-size={size}
            {...props}
          >
            {children}
            {showClose ? (
              <BaseDialog.Close
                render={
                  <IconButton
                    className="gyro-dialog__close"
                    label={closeLabel}
                    size="sm"
                  />
                }
              >
                <X aria-hidden size={14} />
              </BaseDialog.Close>
            ) : null}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    );
  },
);

export interface AlertDialogContentProps
  extends Omit<BaseAlertDialog.Popup.Props, "className"> {
  className?: string;
  size?: DialogSize;
}

const AlertDialogContent = forwardRef<HTMLDivElement, AlertDialogContentProps>(
  function AlertDialogContent({ className, size = "sm", ...props }, ref) {
    return (
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="gyro-dialog-backdrop" />
        <BaseAlertDialog.Viewport className="gyro-dialog-viewport">
          <BaseAlertDialog.Popup
            ref={ref}
            className={cx("gyro-dialog", className)}
            data-size={size}
            data-alert=""
            {...props}
          />
        </BaseAlertDialog.Viewport>
      </BaseAlertDialog.Portal>
    );
  },
);

type DivProps = HTMLAttributes<HTMLDivElement>;

function sectionPart(base: string, displayName: string) {
  const Part = forwardRef<HTMLDivElement, DivProps>(function Part(
    { className, ...props },
    ref,
  ) {
    return <div ref={ref} className={cx(base, className)} {...props} />;
  });
  Part.displayName = displayName;
  return Part;
}

const DialogHeader = sectionPart("gyro-dialog__header", "DialogHeader");
const DialogBody = sectionPart("gyro-dialog__body", "DialogBody");
const DialogFooter = sectionPart("gyro-dialog__footer", "DialogFooter");

export interface DialogHeroBandProps extends DivProps {
  /** Illustration or scene rendered in the band (Phase 9 scenes). */
  children?: ReactNode;
}

/** Optional illustrated band across the top of a larger dialog. */
const DialogHeroBand = sectionPart("gyro-dialog__hero", "DialogHeroBand") as (
  props: DialogHeroBandProps,
) => ReactNode;

export const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Content: DialogContent,
  Header: DialogHeader,
  HeroBand: DialogHeroBand,
  Body: DialogBody,
  Footer: DialogFooter,
  Title: styledPart(BaseDialog.Title, "gyro-dialog__title", "DialogTitle"),
  Description: styledPart(
    BaseDialog.Description,
    "gyro-dialog__description",
    "DialogDescription",
  ),
  Close: BaseDialog.Close,
  createHandle: BaseDialog.createHandle,
};

export const AlertDialog = {
  Root: BaseAlertDialog.Root,
  Trigger: BaseAlertDialog.Trigger,
  Content: AlertDialogContent,
  Header: DialogHeader,
  Body: DialogBody,
  Footer: DialogFooter,
  Title: styledPart(
    BaseAlertDialog.Title,
    "gyro-dialog__title",
    "AlertDialogTitle",
  ),
  Description: styledPart(
    BaseAlertDialog.Description,
    "gyro-dialog__description",
    "AlertDialogDescription",
  ),
  Close: BaseAlertDialog.Close,
  createHandle: BaseAlertDialog.createHandle,
};
