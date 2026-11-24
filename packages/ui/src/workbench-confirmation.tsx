import { useRef, useState, type ReactNode } from "react";
import { Button, Dialog } from "./primitives";
import "./workbench-confirmation.css";

export function WorkbenchConfirmation({
  title,
  description,
  detail,
  icon,
  confirmLabel,
  confirmDisabled,
  cancelLabel = "Cancel",
  secondaryAction,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  secondaryAction?: { label: string; run: () => void };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(true);
  const cancelButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Content
        className="gyro-workbench-confirmation"
        role="alertdialog"
        size="sm"
        initialFocus={cancelButton}
      >
        <Dialog.Header>
          <Dialog.Title>
            {icon}
            {title}
          </Dialog.Title>
        </Dialog.Header>
        <Dialog.Body>
          <Dialog.Description>{description}</Dialog.Description>
          {detail}
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Close
            render={<Button ref={cancelButton} variant="outline" size="sm" />}
          >
            {cancelLabel}
          </Dialog.Close>
          {secondaryAction ? (
            <Button variant="outline" size="sm" onClick={secondaryAction.run}>
              {secondaryAction.label}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            size="sm"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
