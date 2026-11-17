/** Route both AppKit and browser shortcuts to the terminal owning the keyboard. */
export function clearFocusedTerminal(): boolean {
  const host = document.activeElement?.closest(".gyro-xterm-host");
  if (!host) return false;
  return !host.dispatchEvent(
    new Event("gyro-terminal-clear", { cancelable: true }),
  );
}
