import { useEffect, useRef } from "react";
import type { EditorBuffer, WorkspaceScopedSettings } from "@gyro-dev/ui";

type AutoSaveMode = NonNullable<WorkspaceScopedSettings["filesAutoSave"]>;

/**
 * A buffer auto-save may write: edited, fully loaded, and not waiting on the
 * user (a conflict or failed write needs an explicit ⌘S, not a retry loop).
 */
export function autoSavableBuffer(buffer: EditorBuffer | undefined) {
  return Boolean(
    buffer &&
      buffer.content !== buffer.savedContent &&
      !buffer.truncated &&
      buffer.status !== "conflict" &&
      buffer.status !== "error" &&
      buffer.status !== "saving" &&
      buffer.status !== "loading",
  );
}

/**
 * `afterDelay` writes edited buffers once typing pauses for `delay` ms.
 * `onFocusChange` writes the file you leave when the active editor changes,
 * and every edited file when the window loses focus. Saves are quiet and
 * never overlap for one path, so a slow write is not raced by the next one.
 */
export function useAutoSave(options: {
  mode: AutoSaveMode;
  delay: number;
  buffers: Record<string, EditorBuffer>;
  activePath?: string;
  save(path: string): Promise<unknown>;
}) {
  const { mode, delay, buffers, activePath } = options;
  const latest = useRef(options);
  latest.current = options;
  const inFlight = useRef(new Set<string>());

  const saveDirty = useRef((paths?: readonly string[]) => {
    const { buffers: current, save } = latest.current;
    for (const path of paths ?? Object.keys(current)) {
      if (inFlight.current.has(path) || !autoSavableBuffer(current[path]))
        continue;
      inFlight.current.add(path);
      void Promise.resolve(save(path))
        .catch(() => undefined)
        .finally(() => inFlight.current.delete(path));
    }
  }).current;

  useEffect(() => {
    if (mode !== "afterDelay") return;
    if (!Object.values(buffers).some(autoSavableBuffer)) return;
    const timer = window.setTimeout(() => saveDirty(), delay);
    return () => window.clearTimeout(timer);
  }, [buffers, delay, mode, saveDirty]);

  const previousActive = useRef(activePath);
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = activePath;
    if (mode === "onFocusChange" && previous && previous !== activePath)
      saveDirty([previous]);
  }, [activePath, mode, saveDirty]);

  useEffect(() => {
    if (mode === "off") return;
    // Both modes write on blur: a pending delay should not be lost when the
    // user switches to another app to run what they just wrote.
    const onBlur = () => saveDirty();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [mode, saveDirty]);
}
