import {
  editorBufferRecoveryCapacity,
  persistableDirtyEditorBuffers,
  sanitizeStoredIdeState,
  createInitialWorkbenchState,
  type EditorBuffer,
  type WorkbenchState,
} from "@gyro-dev/ui";

export const EDIT_RECOVERY_KEY = "gyro.workspace-edit-recovery.v1";
const MAX_JOURNAL_CHARS = 7_000_000;
type StoragePort = Pick<Storage, "getItem" | "setItem">;

/** Transaction drafts are durable independently of tabs and the debounced UI snapshot. */
export function writeEditRecovery(
  buffers: Record<string, EditorBuffer>,
  storage: StoragePort = window.localStorage,
) {
  const capacity = editorBufferRecoveryCapacity(buffers);
  if (!capacity.ok) throw new Error(capacity.reason);
  const serialized = JSON.stringify({
    version: 1,
    writtenAt: Date.now(),
    buffers: persistableDirtyEditorBuffers(buffers),
  });
  if (serialized.length > MAX_JOURNAL_CHARS)
    throw new Error(
      "The changes exceed recovery storage. Save existing changes first.",
    );
  storage.setItem(EDIT_RECOVERY_KEY, serialized);
  if (storage.getItem(EDIT_RECOVERY_KEY) !== serialized)
    throw new Error(
      "Recovery storage is unavailable. The changes were not applied.",
    );
}

export function readEditRecovery(
  storage: StoragePort = window.localStorage,
): Record<string, EditorBuffer> {
  const serialized = storage.getItem(EDIT_RECOVERY_KEY);
  if (!serialized) return {};
  if (serialized.length > MAX_JOURNAL_CHARS)
    throw new Error("Workspace edit recovery is too large.");
  const journal = JSON.parse(serialized);
  if (
    !journal ||
    journal.version !== 1 ||
    !journal.buffers ||
    typeof journal.buffers !== "object" ||
    Array.isArray(journal.buffers)
  )
    throw new Error("Workspace edit recovery could not be read.");
  const base = createInitialWorkbenchState().ide;
  const restored = sanitizeStoredIdeState(
    { ...base, buffers: journal.buffers },
    base,
  ).buffers;
  if (Object.keys(restored).length !== Object.keys(journal.buffers).length)
    throw new Error("Some workspace changes could not be recovered.");
  return restored;
}

export function hasEditRecovery() {
  try {
    return window.localStorage.getItem(EDIT_RECOVERY_KEY) !== null;
  } catch {
    return false;
  }
}

export function recoverWorkspaceBuffers(state: WorkbenchState): WorkbenchState {
  try {
    if (!hasEditRecovery()) return state;
    const recovered = readEditRecovery();
    const journal = JSON.parse(window.localStorage.getItem(EDIT_RECOVERY_KEY)!);
    const writtenAt =
      typeof journal.writtenAt === "number" &&
      Number.isFinite(journal.writtenAt)
        ? journal.writtenAt
        : undefined;
    // The journal records the complete dirty set; an empty journal clears stale
    // drafts from a UI snapshot written before Save All completed.
    const clean = Object.fromEntries(
      Object.entries(state.ide.buffers).filter(
        ([, buffer]) => buffer.content === buffer.savedContent,
      ),
    );
    const buffers = { ...clean, ...recovered };
    for (const [path, buffer] of Object.entries(state.ide.buffers)) {
      if (buffer.content === buffer.savedContent) continue;
      const updatedAt = Date.parse(buffer.updatedAt);
      // A failed journal update must not discard a newer durable UI draft.
      // Legacy journals without a timestamp cannot authoritatively clear drafts.
      if (
        writtenAt === undefined
          ? !recovered[path] ||
            updatedAt >= Date.parse(recovered[path]!.updatedAt)
          : updatedAt > writtenAt
      )
        buffers[path] = buffer;
    }
    const dirty = (path: string) =>
      buffers[path]?.content !== undefined &&
      buffers[path]?.content !== buffers[path]?.savedContent;
    return {
      ...state,
      ide: {
        ...state.ide,
        buffers,
        tabs: state.ide.tabs.map((tab) => ({
          ...tab,
          dirty: dirty(tab.path),
          ...(dirty(tab.path) ? { pinned: true, preview: false } : {}),
        })),
        layout: {
          ...state.ide.layout,
          groups: state.ide.layout.groups.map((group) => ({
            ...group,
            tabs: group.tabs.map((tab) => ({
              ...tab,
              dirty: dirty(tab.path),
              ...(dirty(tab.path) ? { pinned: true, preview: false } : {}),
            })),
          })),
        },
      },
    };
  } catch {
    return state;
  }
}
