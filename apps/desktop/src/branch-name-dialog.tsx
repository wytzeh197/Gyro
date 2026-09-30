import { useEffect, useRef, useState } from "react";
import { Dialog } from "@gyro-dev/ui";

// One naming dialog for branches and chats, so neither falls back to the
// native window.prompt (unstyled in the webview, and blocking).
const COPY = {
  create: {
    title: "New branch",
    label: "Branch name",
    submit: "Create branch",
    placeholder: "feature/my-change",
  },
  rename: {
    title: "Rename current branch",
    label: "Branch name",
    submit: "Rename branch",
    placeholder: "feature/my-change",
  },
  chat: {
    title: "Rename chat",
    label: "Chat name",
    submit: "Rename chat",
    placeholder: "Chat name",
  },
} as const;

export function BranchNameDialog({
  startPoint,
  initialValue,
  mode = "create",
  onFinish,
}: {
  startPoint?: string;
  initialValue: string;
  mode?: keyof typeof COPY;
  onFinish: (name?: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialValue);
  const copy = COPY[mode];
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
            {copy.submit}
          </button>
        </>
      }
      className="gyro-branch-name-dialog"
      closeLabel="Cancel"
      description={
        mode === "chat" ? undefined : mode === "rename" ? (
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
      title={copy.title}
    >
      <form
        id="gyro-branch-name-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onFinish(name.trim());
        }}
      >
        <label className="gyro-field" htmlFor="gyro-branch-name">
          {copy.label}
          <input
            ref={inputRef}
            autoComplete="off"
            className="gyro-input"
            id="gyro-branch-name"
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.placeholder}
            required
            spellCheck={mode === "chat"}
            value={name}
          />
        </label>
      </form>
    </Dialog>
  );
}
