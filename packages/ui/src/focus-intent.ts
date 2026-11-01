/**
 * Focus ownership for background surfaces.
 *
 * Gyro keeps long-lived surfaces alive while the user works elsewhere: terminal
 * panes, code editors, and the chat composer. Panes and editors used to call
 * `element.focus()` from effects keyed on props that change without the user
 * asking for anything (a PTY status flip, an appearance change, an agent edit),
 * which pulled the caret out of the composer mid-sentence and made keystrokes
 * disappear into a terminal nobody was reading.
 *
 * The rule these helpers enforce: a surface may take focus when the user asks
 * for it, and must stay out of the way when the user is typing in a text field
 * it does not own.
 */

const TEXT_INPUT_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Surfaces that own the keyboard even though they are not plain inputs. */
const FOCUS_OWNING_SELECTORS = [".monaco-editor", ".xterm"];

/** The element that currently has focus, or null outside a DOM. */
export function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** True when `target` accepts typed text. */
export function isTextInput(target: Element | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return TEXT_INPUT_TAGS.has(target.tagName);
}

/**
 * True when focus already belongs to a surface such as a terminal pane or a
 * code editor — including `owner` itself and anything nested in it.
 */
export function surfaceOwnsFocus(
  target: Element | null | undefined,
  owner?: Element | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (owner && owner.contains(target)) return true;
  return FOCUS_OWNING_SELECTORS.some(
    (selector) => target.closest(selector) !== null,
  );
}

/**
 * True when the user is typing somewhere `owner` must not take focus from.
 *
 * Call this before any programmatic `focus()` that is not the direct result of
 * a click, keypress, or explicit navigation inside `owner`.
 */
export function userIsTypingElsewhere(owner?: Element | null): boolean {
  const active = focusedElement();
  if (!active || active === document.body) return false;
  if (surfaceOwnsFocus(active, owner)) return false;
  return isTextInput(active);
}
