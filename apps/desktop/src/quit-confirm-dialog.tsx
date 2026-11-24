import { useRef, useState } from "react";
import "./quit-confirm-dialog.css";
import { AlertDialog, Button, Kbd } from "@gyro-dev/ui";

export function QuitConfirmDialog({
  onResolve,
  willInstallUpdate,
}: {
  onResolve: (quit: boolean) => Promise<void>;
  willInstallUpdate?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"quit" | "cancel" | null>(null);
  const [error, setError] = useState<string>();

  async function resolve(quit: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPending(quit ? "quit" : "cancel");
    setError(undefined);
    try {
      await onResolve(quit);
    } catch (failure) {
      busyRef.current = false;
      setBusy(false);
      setPending(null);
      setError(
        quit
          ? `Gyro could not save your session before closing. ${String(failure)}`
          : "Gyro could not dismiss this prompt. Try again.",
      );
    }
  }

  return (
    <AlertDialog.Root
      open
      onOpenChange={(next) => {
        if (!next) void resolve(false);
      }}
    >
      <AlertDialog.Content
        className="gyro-quit-dialog"
        aria-labelledby="gyro-quit-title"
        aria-describedby="gyro-quit-description"
        aria-busy={busy}
        initialFocus={cancelRef}
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <AlertDialog.Header>
          <AlertDialog.Title id="gyro-quit-title">Quit Gyro?</AlertDialog.Title>
          <AlertDialog.Description id="gyro-quit-description">
            {willInstallUpdate
              ? "Gyro will install the downloaded update before closing."
              : "Gyro will close."}
          </AlertDialog.Description>
          {error ? (
            <p className="gyro-quit-error" role="alert">
              {error}
            </p>
          ) : null}
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button
            ref={cancelRef}
            className="gyro-quit-cancel"
            disabled={busy}
            onClick={() => void resolve(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {pending === "cancel" ? "Cancelling…" : "Cancel"}
            {pending ? null : <Kbd aria-hidden="true">Esc</Kbd>}
          </Button>
          <Button
            className="gyro-quit-confirm"
            disabled={busy}
            onClick={() => void resolve(true)}
            size="sm"
            type="button"
          >
            {pending === "quit" ? "Quitting…" : "Quit"}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
