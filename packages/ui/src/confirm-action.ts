/**
 * Blocking confirmations for destructive actions.
 *
 * `window.confirm` and `window.prompt` are browser dialogs, and the macOS
 * WebView Gyro runs in (wry, `WKWebView`) implements no JavaScript panel
 * delegates at all: WebKit suppresses the dialog, `confirm` returns false and
 * `prompt` returns null. Anything gated on them cancels itself with no
 * feedback, which is exactly how file rename, delete, and discard silently
 * stopped working.
 *
 * The desktop shell installs a native dialog handler once at startup; every
 * shared surface asks through here instead of touching `window`.
 */
type ConfirmHandler = (message: string) => Promise<boolean>;

let confirmHandler: ConfirmHandler | undefined;

export function setConfirmActionHandler(handler: ConfirmHandler | undefined) {
  confirmHandler = handler;
}

const hasNativeConfirm = () =>
  typeof window !== "undefined" && typeof window.confirm === "function";

/**
 * A browser preview's own confirmation, for a host that keeps no native dialog.
 * The shell installs its handler above; this is the one remaining place the
 * platform dialog is reached for, and it lives here so `window.confirm` has a
 * single owner.
 */
export function browserConfirm(message: string): boolean {
  return hasNativeConfirm() ? window.confirm(message) : true;
}

export async function confirmAction(message: string): Promise<boolean> {
  if (confirmHandler) {
    try {
      return await confirmHandler(message);
    } catch {
      return false;
    }
  }
  /* A browser dev preview keeps the plain dialog; a host without one must not
     block the action it is confirming. */
  return hasNativeConfirm() ? window.confirm(message) : true;
}
