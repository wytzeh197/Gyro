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
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
  onClose,
}: {
  options: TextPromptOptions;
  onClose: (value: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(options.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    field.current?.focus();
    field.current?.select();
  }, []);

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
    <dialog
      aria-label={options.title}
      className="gyro-text-prompt"
      onCancel={(event) => {
        event.preventDefault();
        onClose(null);
      }}
      ref={dialog}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <h2 className="gyro-text-prompt-title">{options.title}</h2>
        {options.message ? (
          <p className="gyro-text-prompt-message">{options.message}</p>
        ) : null}
        <label className="gyro-text-prompt-field">
          <span>{options.label ?? "Name"}</span>
          <input
            aria-invalid={error ? true : undefined}
            autoComplete="off"
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
          <button
            className="gyro-secondary-button"
            onClick={() => onClose(null)}
            type="button"
          >
            Cancel
          </button>
          <button className="gyro-primary-button" type="submit">
            {options.confirmLabel ?? "Save"}
          </button>
        </div>
      </form>
    </dialog>
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
    const close = (value: string | null) => {
      if (settled) return;
      settled = true;
      closeActivePrompt = null;
      resolve(value);
      // Unmount after the caller resumes, so a submit handler is never torn
      // down in the middle of its own event.
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    closeActivePrompt = close;
    root.render(<TextPromptDialog onClose={close} options={options} />);
  });
}
