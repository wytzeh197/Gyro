/** Read only bounded UI state; unavailable or oversized storage restores defaults. */
export function readBoundedLocalStorage(key: string, maxChars: number) {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored || stored.length > maxChars) return undefined;
    return stored;
  } catch {
    return undefined;
  }
}

export function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Local storage can be unavailable or quota-limited in preview contexts.
  }
}
