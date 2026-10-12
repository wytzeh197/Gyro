import { useEffect, useRef, useState } from "react";
import "./quit-confirm-dialog.css";

export function QuitConfirmDialog({
  onResolve,
}: {
  onResolve: (quit: boolean) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);

  async function resolve(quit: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(quit);
    } catch {
      busyRef.current = false;
      setBusy(false);
      setError("Could not complete the request. Please try again.");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="gyro-quit-dialog"
      aria-labelledby="gyro-quit-title"
      aria-describedby="gyro-quit-description"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        void resolve(false);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="gyro-quit-dialog-body">
        <h2 id="gyro-quit-title">Quit Gyro?</h2>
        <p id="gyro-quit-description">Are you sure you want to quit?</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer>
        <button
          ref={cancelRef}
          className="gyro-quit-cancel"
          disabled={busy}
          onClick={() => void resolve(false)}
        >
          Cancel <kbd aria-hidden="true">Esc</kbd>
        </button>
        <button
          className="gyro-quit-confirm"
          disabled={busy}
          onClick={() => void resolve(true)}
        >
          Quit
        </button>
      </footer>
    </dialog>
  );
}
