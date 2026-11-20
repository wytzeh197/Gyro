import type { EditorBuffer } from "@gyro-dev/ui";

/** Reconcile background/split tabs without moving editor focus or replacing
 * text typed while a stat/read was in flight. The reducer rechecks the base. */
export async function refreshOpenEditorBuffers(options: {
  paths: string[];
  getBuffer: (path: string) => EditorBuffer | undefined;
  cancelled: () => boolean;
  stat: (path: string) => Promise<{ contentHash?: string; kind?: string }>;
  read: (path: string) => Promise<EditorBuffer>;
  apply: (before: EditorBuffer, after: EditorBuffer) => void;
  conflict: (path: string, error: string) => void;
}) {
  for (const path of options.paths) {
    if (options.cancelled()) return;
    const before = options.getBuffer(path);
    if (!before?.contentHash || before.status === "saving") continue;
    const current = () => {
      const live = options.getBuffer(path);
      return !options.cancelled() && live?.content === before.content &&
        live?.contentHash === before.contentHash && live?.status !== "saving";
    };
    try {
      const stat = await options.stat(path);
      if (!current()) continue;
      if (stat.kind === "missing") {
        options.conflict(path, "File is missing from disk. Your editor text has been retained.");
        continue;
      }
      if (!stat.contentHash) continue;
      if (stat.contentHash === before.contentHash &&
          (before.status !== "error" || before.content !== before.savedContent)) continue;
      if (before.content !== before.savedContent) {
        options.conflict(path, "File changed on disk; reload or preserve your buffer before saving.");
        continue;
      }
      const after = await options.read(path);
      if (current()) options.apply(before, after);
    } catch {
      // One inaccessible file must not prevent reconciliation of other tabs.
    }
  }
}
