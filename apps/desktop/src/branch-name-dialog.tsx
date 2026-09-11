import { useEffect, useRef, useState } from "react";
import "./branch-name-dialog.css";

/** Native HTML dialog provides focus containment and Escape in the desktop webview. */
export function BranchNameDialog({
  startPoint,
  initialValue,
  mode = "create",
  onFinish,
}: {
  startPoint?: string;
  initialValue: string;
  mode?: "create" | "rename";
  onFinish: (name?: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialValue);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="gyro-branch-name-dialog"
      aria-labelledby="gyro-branch-name-title"
      aria-describedby="gyro-branch-name-description"
      onCancel={(event) => {
        event.preventDefault();
        onFinish();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onFinish(name.trim());
        }}
      >
        <h2 id="gyro-branch-name-title">
          {mode === "rename" ? "Rename current branch" : "New branch"}
        </h2>
        <p id="gyro-branch-name-description">
          {mode === "rename" ? (
            "Rename the branch checked out in this workspace."
          ) : startPoint ? (
            <>
              Create and switch to a branch from <code>{startPoint}</code>.
            </>
          ) : (
            "Create and switch to a branch from the current commit."
          )}
        </p>
        <div className="gyro-branch-name-dialog-field">
          <label htmlFor="gyro-branch-name">Branch name</label>
          <input
            ref={inputRef}
            id="gyro-branch-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feature/my-change"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <footer>
          <button
            className="gyro-secondary-button"
            type="button"
            onClick={() => onFinish()}
          >
            Cancel
          </button>
          <button
            className="gyro-primary-button"
            type="submit"
            disabled={!name.trim()}
          >
            {mode === "rename" ? "Rename branch" : "Create branch"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
