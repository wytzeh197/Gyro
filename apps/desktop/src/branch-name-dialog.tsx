import { useEffect, useRef, useState } from "react";
import { Dialog } from "@gyro-dev/ui";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialValue);
  // Dialog focuses the field; select its text so a rename can be typed over.
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  return (
    <Dialog
      actions={
        <>
          <button
            className="gyro-button is-secondary"
            type="button"
            onClick={() => onFinish()}
          >
            Cancel
          </button>
          <button
            className="gyro-button is-primary"
            disabled={!name.trim()}
            form="gyro-branch-name-form"
            type="submit"
          >
            {mode === "rename" ? "Rename branch" : "Create branch"}
          </button>
        </>
      }
      className="gyro-branch-name-dialog"
      closeLabel="Cancel"
      description={
        mode === "rename" ? (
          "Rename the branch checked out in this workspace."
        ) : startPoint ? (
          <>
            Create and switch to a branch from <code>{startPoint}</code>.
          </>
        ) : (
          "Create and switch to a branch from the current commit."
        )
      }
      onClose={() => onFinish()}
      onKeyDown={(event) => event.stopPropagation()}
      open
      title={mode === "rename" ? "Rename current branch" : "New branch"}
    >
      <form
        id="gyro-branch-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onFinish(name.trim());
        }}
      >
        <label className="gyro-field" htmlFor="gyro-branch-name">
          Branch name
          <input
            ref={inputRef}
            autoComplete="off"
            className="gyro-input"
            id="gyro-branch-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="feature/my-change"
            required
            spellCheck={false}
            value={name}
          />
        </label>
      </form>
    </Dialog>
  );
}
