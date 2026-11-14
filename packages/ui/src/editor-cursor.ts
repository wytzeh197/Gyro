import { useSyncExternalStore } from "react";

export type EditorCursorPosition = { lineNumber: number; column: number };

/**
 * Last cursor position per open file, kept outside React state so cursor
 * moves re-render only the breadcrumbs and Outline that read them, never the
 * whole workbench.
 */
const positions = new Map<string, EditorCursorPosition>();
const listeners = new Set<() => void>();

export function setEditorCursor(path: string, position: EditorCursorPosition) {
  const previous = positions.get(path);
  if (
    previous?.lineNumber === position.lineNumber &&
    previous.column === position.column
  )
    return;
  positions.set(path, { lineNumber: position.lineNumber, column: position.column });
  for (const listener of listeners) listener();
}

export function editorCursor(path: string) {
  return positions.get(path);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorCursor(path?: string) {
  return useSyncExternalStore(
    subscribe,
    () => (path ? positions.get(path) : undefined),
    () => undefined,
  );
}
