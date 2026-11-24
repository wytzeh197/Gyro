/**
 * An in-app text prompt.
 *
 * `window.prompt` cannot be used in this shell: Gyro's macOS window is a
 * `WKWebView` whose UI delegate implements no JavaScript panel methods, so
 * WebKit suppresses the dialog and `prompt()` returns null. Every rename that
 * depended on it cancelled itself with no feedback and no error.
 *
 * `askTextValue` opens a real dialog instead: it renders into its own host
 * element on `document.body`, resolves with the trimmed value on confirm, and
 * resolves with null when the prompt is dismissed.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Dialog, Input } from "./primitives";
import "./text-prompt.css";

export type TextPromptOptions = {
  /** Heading, and the accessible name of the dialog. */
  title: string;
  /** Field label. Defaults to "Name". */
  label?: string;
  /** One line of context under the heading. */
  message?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** Returns a message to show instead of submitting. */
  validate?: (value: string) => string | null;
};

function TextPromptDialog({
  options,
  open,
  onClose,
  onExited,
}: {
  options: TextPromptOptions;
  open: boolean;
  onClose: (value: string | null) => void;
  onExited: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(options.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const next = value.trim();
    if (!next) {
      setError("Enter a name.");
      return;
    }
    const refusal = options.validate?.(next) ?? null;
    if (refusal) {
      setError(refusal);
      return;
    }
    onClose(next);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(null);
      }}
      onOpenChangeComplete={(next) => {
        if (next) field.current?.select();
        else onExited();
      }}
    >
      <Dialog.Content
        aria-label={options.title}
        className="gyro-text-prompt"
        initialFocus={field}
        size="sm"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <Dialog.Title>{options.title}</Dialog.Title>
          {options.message ? (
            <Dialog.Description>{options.message}</Dialog.Description>
          ) : null}
          <label className="gyro-text-prompt-field">
            <span>{options.label ?? "Name"}</span>
            <Input
              autoComplete="off"
              invalid={!!error}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              ref={field}
              spellCheck={false}
              value={value}
            />
          </label>
          {error ? (
            <p className="gyro-text-prompt-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="gyro-text-prompt-actions">
            <Button
              onClick={() => onClose(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button size="sm" type="submit">
              {options.confirmLabel ?? "Save"}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

let closeActivePrompt: ((value: string | null) => void) | null = null;

/**
 * Ask for one line of text. Resolves with the trimmed value, or null when the
 * prompt is dismissed. A second call settles the first prompt as cancelled, so
 * two prompts never stack.
 */
export function askTextValue(
  options: TextPromptOptions,
): Promise<string | null> {
  if (typeof document === "undefined") {
    return Promise.resolve(null);
  }
  closeActivePrompt?.(null);

  const host = document.createElement("div");
  host.className = "gyro-text-prompt-host";
  document.body.appendChild(host);
  const root = createRoot(host);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      root.unmount();
      host.remove();
    };
    const render = (open: boolean) =>
      root.render(
        <TextPromptDialog
          onClose={close}
          onExited={() => queueMicrotask(remove)}
          open={open}
          options={options}
        />,
      );
    function close(value: string | null) {
      if (settled) return;
      settled = true;
      closeActivePrompt = null;
      resolve(value);
      // Play the exit, then unmount after the caller resumes, so a submit
      // handler is never torn down mid-event. The timer covers a window that
      // never paints, where transitions do not finish.
      render(false);
      window.setTimeout(remove, 1000);
    }
    closeActivePrompt = close;
    render(true);
  });
}
