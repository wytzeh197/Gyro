import { useRef, useState } from "react";
import "./branch-name-dialog.css";
import { Button, Dialog, Input } from "@gyro-dev/ui";

/** The parent mounts this while it is open; Dialog owns focus, Escape and focus return. */
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
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onFinish();
      }}
      onOpenChangeComplete={(next) => {
        if (next) inputRef.current?.select();
      }}
    >
      <Dialog.Content
        className="gyro-branch-name-dialog"
        aria-labelledby="gyro-branch-name-title"
        aria-describedby="gyro-branch-name-description"
        initialFocus={inputRef}
        size="sm"
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onFinish(name.trim());
          }}
        >
          <Dialog.Title id="gyro-branch-name-title">
            {mode === "rename" ? "Rename current branch" : "New branch"}
          </Dialog.Title>
          <Dialog.Description id="gyro-branch-name-description">
            {mode === "rename" ? (
              "Rename the branch checked out in this workspace."
            ) : startPoint ? (
              <>
                Create and switch to a branch from <code>{startPoint}</code>.
              </>
            ) : (
              "Create and switch to a branch from the current commit."
            )}
          </Dialog.Description>
          <div className="gyro-branch-name-dialog-field">
            <label htmlFor="gyro-branch-name">Branch name</label>
            <Input
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
          <footer className="gyro-branch-name-dialog-actions">
            <Button variant="outline" size="sm" type="button" onClick={() => onFinish()}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={!name.trim()}>
              {mode === "rename" ? "Rename branch" : "Create branch"}
            </Button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
