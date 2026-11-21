/**
 * The in-app confirmation dialog.
 *
 * Replaces the stock macOS alert (and the browser's `window.confirm`) with a
 * Gyro surface: same card, scrim and buttons as the text prompt, with the
 * confirm button named after what it does ("Discard", "Move to Trash") and
 * tinted red when the action loses work.
 */
import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import "./text-prompt.css";

export type ConfirmDialogOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default" | "permission";
  detail?: { label: string; value: string };
};

type Verb = { pattern: RegExp; label: string; danger: boolean };

const VERBS: Verb[] = [
  {
    pattern: /\bto the (host's )?trash\b/i,
    label: "Move to Trash",
    danger: true,
  },
  { pattern: /^discard\b/i, label: "Discard", danger: true },
  { pattern: /^delete\b/i, label: "Delete", danger: true },
  { pattern: /^remove\b/i, label: "Remove", danger: true },
  { pattern: /^close\b/i, label: "Close", danger: true },
  { pattern: /^replace\b/i, label: "Replace", danger: false },
  { pattern: /\bclear\b/i, label: "Clear", danger: false },
];

/** Name the confirm button after the action the message asks about. */
export function describeConfirmation(message: string): Required<
  Pick<ConfirmDialogOptions, "title" | "confirmLabel" | "tone">
> & {
  acknowledgeOnly: boolean;
} {
  const trimmed = message.trim();
  // A statement, not a question, only needs acknowledging.
  if (!trimmed.endsWith("?")) {
    return {
      title: "Heads up",
      confirmLabel: "OK",
      tone: "default",
      acknowledgeOnly: true,
    };
  }
  const verb = VERBS.find((entry) => entry.pattern.test(trimmed));
  const danger = verb?.danger ?? false;
  return {
    title: danger ? "Are you sure?" : "Confirm",
    confirmLabel: verb?.label ?? "Continue",
    tone: danger ? "danger" : "default",
    acknowledgeOnly: false,
  };
}

function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmDialogOptions;
  onClose: (value: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const derived = describeConfirmation(options.message);
  const tone = options.tone ?? derived.tone;
  const title = options.title ?? derived.title;
  const acknowledgeOnly = derived.acknowledgeOnly && tone !== "permission";

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement;
    if (!element.open) element.showModal();
    (tone !== "default" && !acknowledgeOnly
      ? cancelButton.current
      : confirmButton.current
    )?.focus();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [acknowledgeOnly, tone]);

  const Icon = {
    danger: AlertTriangle,
    default: Info,
    permission: ShieldAlert,
  }[tone];

  return (
    <dialog
      aria-describedby={
        options.detail
          ? "gyro-confirm-message gyro-confirm-detail"
          : "gyro-confirm-message"
      }
      aria-label={title}
      className={`gyro-text-prompt gyro-confirm-dialog is-${tone}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose(false);
      }}
      ref={dialog}
      role="alertdialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onClose(true);
        }}
      >
        <div className="gyro-confirm-dialog-head">
          <span aria-hidden="true" className="gyro-confirm-dialog-icon">
            <Icon size={15} strokeWidth={2} />
          </span>
          <div>
            <h2 className="gyro-text-prompt-title">{title}</h2>
            <p className="gyro-text-prompt-message" id="gyro-confirm-message">
              {options.message}
            </p>
            {options.detail ? (
              <dl
                className="gyro-confirm-dialog-detail"
                id="gyro-confirm-detail"
              >
                <dt>{options.detail.label}</dt>
                <dd>{options.detail.value}</dd>
              </dl>
            ) : null}
          </div>
        </div>
        <div className="gyro-text-prompt-actions">
          {acknowledgeOnly ? null : (
            <button
              className="gyro-secondary-button"
              onClick={() => onClose(false)}
              ref={cancelButton}
              type="button"
            >
              {options.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            className={`gyro-primary-button${tone === "danger" ? " is-danger" : ""}`}
            ref={confirmButton}
            type="submit"
          >
            {options.confirmLabel ?? derived.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

let closeActiveConfirm: ((value: boolean) => void) | null = null;

/**
 * Ask a yes/no question in a Gyro dialog. Resolves true on confirm, false when
 * dismissed. A second call settles the first as cancelled.
 */
export function askConfirmation(
  input: string | ConfirmDialogOptions,
): Promise<boolean> {
  const options = typeof input === "string" ? { message: input } : input;
  if (typeof document === "undefined") return Promise.resolve(false);
  closeActiveConfirm?.(false);

  const host = document.createElement("div");
  host.className = "gyro-text-prompt-host";
  document.body.appendChild(host);
  const root = createRoot(host);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const close = (value: boolean) => {
      if (settled) return;
      settled = true;
      closeActiveConfirm = null;
      resolve(value);
      queueMicrotask(() => {
        root.unmount();
        host.remove();
      });
    };
    closeActiveConfirm = close;
    root.render(<ConfirmDialog onClose={close} options={options} />);
  });
}
