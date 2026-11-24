import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, Input } from "./primitives";
import "./workspace-rename.css";

export type RenamePreviewFile = { path: string; before: string; after: string };

export function WorkspaceRenameDialog({
  name,
  files,
  busy,
  error,
  onPreview,
  onApply,
  onCancel,
  renderDiff,
}: {
  name: string;
  files?: RenamePreviewFile[];
  busy: boolean;
  error?: string;
  onPreview(name: string): void;
  onApply(): void;
  onCancel(): void;
  renderDiff(file: RenamePreviewFile): ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const apply = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState(name);
  const [selected, setSelected] = useState(0);
  useEffect(() => setValue(name), [name]);
  useEffect(() => {
    if (busy) {
      cancel.current?.focus();
      return;
    }
    if (files) apply.current?.focus();
    else {
      input.current?.focus();
      input.current?.select();
    }
  }, [Boolean(files), busy]);
  const file = files?.[Math.min(selected, files.length - 1)];
  // The caller mounts the dialog while a rename is in progress and unmounts it
  // when it ends, so it is always open; dismissal goes through onCancel.
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Content
        className={`gyro-workspace-rename ${files ? "is-preview" : ""}`}
        aria-labelledby="gyro-workspace-rename-title"
        initialFocus={input}
        size={files ? "lg" : "sm"}
        onKeyDown={(event) => {
          // Keep editor shortcuts out of the dialog; Escape still dismisses.
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (files) {
              if (files.length) onApply();
            } else if (value.trim()) onPreview(value.trim());
          }}
        >
          <Dialog.Title id="gyro-workspace-rename-title">
            Rename symbol
          </Dialog.Title>
          {files ? (
            <p>
              {files.length} {files.length === 1 ? "file" : "files"} will
              change. Changes remain unsaved until saved.
            </p>
          ) : (
            <p>Preview the changes before applying the new name.</p>
          )}
          {!files && (
            <label>
              New name
              <Input
                ref={input}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                required
              />
            </label>
          )}
          {busy && <p role="status">Preparing changes…</p>}
          {error && (
            <p className="gyro-workspace-rename-error" role="alert">
              {error}
            </p>
          )}
          {files && file && (
            <div className="gyro-workspace-rename-preview">
              <nav aria-label="Changed files">
                {files.map((item, index) => (
                  <button
                    type="button"
                    key={item.path}
                    aria-current={index === selected ? "true" : undefined}
                    title={item.path}
                    onClick={() => setSelected(index)}
                  >
                    {item.path}
                  </button>
                ))}
              </nav>
              <div
                className="gyro-workspace-rename-diff"
                aria-label={`Changes in ${file.path}`}
              >
                {renderDiff(file)}
              </div>
            </div>
          )}
          <footer>
            <Button
              ref={cancel}
              size="sm"
              variant="outline"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </Button>
            {files ? (
              <Button
                ref={apply}
                size="sm"
                type="submit"
                disabled={busy || files.length === 0}
              >
                Apply rename
              </Button>
            ) : (
              <Button
                size="sm"
                type="submit"
                disabled={busy || !value.trim()}
              >
                Preview changes
              </Button>
            )}
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function WorkspaceEditBar({
  paths,
  canUndo,
  busy,
  error,
  onUndo,
  onSaveAll,
  onOpenFile,
}: {
  paths: string[];
  canUndo: boolean;
  busy: boolean;
  error?: string;
  onUndo(): void;
  onSaveAll(): void;
  onOpenFile(path: string): void;
}) {
  if (!paths.length && !canUndo && !error) return null;
  return (
    <div
      className="gyro-workspace-edit-bar"
      aria-label="Workspace changes"
    >
      {paths.length > 0 && (
        <details>
          <summary>
            {paths.length} unsaved {paths.length === 1 ? "file" : "files"}
          </summary>
          <div>
            {paths.map((path) => (
              <button
                key={path}
                type="button"
                title={path}
                onClick={() => onOpenFile(path)}
              >
                {path}
              </button>
            ))}
          </div>
        </details>
      )}
      {canUndo && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onUndo}
        >
          Undo rename
        </Button>
      )}
      {paths.length > 0 && (
        <Button
          type="button"
          size="md"
          disabled={busy}
          onClick={onSaveAll}
        >
          Save all
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
