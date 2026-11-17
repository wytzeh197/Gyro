import type { EditorBuffer, WorkbenchState } from "@gyro-dev/ui";

/** IndexedDB is the full draft store; localStorage remains a small legacy fallback. */
export type DraftSnapshot = {
  version: 1;
  writtenAt: number;
  legacyJournalRevision?: string;
  buffers: Record<string, EditorBuffer>;
};
let bootSnapshot: DraftSnapshot | undefined;
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  if (database) return database;
  const request = indexedDB.open("gyro-editor-recovery", 1);
  let abandoned = false;
  const forget = () => {
    if (database === pending) database = undefined;
  };
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        // A blocked request cannot be canceled. Its eventual success must not
        // retain a connection after the caller has already retried.
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => {
      abandoned = true;
      forget();
      reject(request.error);
    };
    request.onblocked = () => {
      abandoned = true;
      forget();
      reject(
        new Error("Editor recovery storage is blocked by another window."),
      );
    };
  });
  database = pending;
  return pending;
}

export function draftSnapshot(
  buffers: Record<string, EditorBuffer>,
): DraftSnapshot {
  return {
    version: 1,
    writtenAt: Date.now(),
    buffers: Object.fromEntries(
      Object.entries(buffers)
        .filter(([, buffer]) => buffer.content !== buffer.savedContent)
        .map(([path, buffer]) => [
          path,
          {
            ...buffer,
            status:
              buffer.status === "error" || buffer.status === "conflict"
                ? buffer.status
                : "dirty",
          },
        ]),
    ),
  };
}

export function validateDraftSnapshot(value: unknown): DraftSnapshot {
  const snapshot = value as DraftSnapshot;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !Number.isFinite(snapshot.writtenAt) ||
    !snapshot.buffers ||
    typeof snapshot.buffers !== "object" ||
    Array.isArray(snapshot.buffers)
  )
    throw new Error(
      "Editor drafts could not be recovered. The stored drafts have been preserved.",
    );
  for (const [path, buffer] of Object.entries(snapshot.buffers)) {
    if (
      !buffer ||
      buffer.path !== path ||
      !path ||
      path.includes("\0") ||
      typeof buffer.content !== "string" ||
      typeof buffer.savedContent !== "string" ||
      buffer.content === buffer.savedContent
    )
      throw new Error(
        "An editor draft could not be recovered. The stored drafts have been preserved.",
      );
  }
  return snapshot;
}

/** Finish reading before mounting App: an empty initial render must never erase recovery. */
export async function initializeDurableEditRecovery() {
  const db = await openDatabase();
  bootSnapshot = await new Promise<DraftSnapshot | undefined>(
    (resolve, reject) => {
      const request = db
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .get("current");
      request.onsuccess = () => {
        try {
          resolve(
            request.result === undefined
              ? undefined
              : validateDraftSnapshot(request.result),
          );
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error);
    },
  );
}

export async function persistDurableEditRecovery(
  buffers: Record<string, EditorBuffer>,
) {
  const snapshot = draftSnapshot(buffers);
  const legacyKey = "gyro.workspace-edit-recovery.v1";
  let coveredJournal: string | null = null;
  try {
    coveredJournal = localStorage.getItem(legacyKey);
    const journal = JSON.parse(coveredJournal ?? "null");
    if (typeof journal?.revision === "string")
      snapshot.legacyJournalRevision = journal.revision;
  } catch {
    /* IDB remains authoritative. */
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    // Read/write transactions on this store serialize commits, including the quit flush.
    const transaction = db.transaction("drafts", "readwrite", {
      durability: "strict",
    });
    transaction.objectStore("drafts").put(snapshot, "current");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Editor recovery was not saved."));
    transaction.onerror = () => reject(transaction.error);
  });
  // Retire only a legacy journal covered by this successful commit. A newer
  // synchronous symbol-edit journal must survive until its own IDB commit.
  try {
    const journal = JSON.parse(coveredJournal ?? "null");
    if (
      coveredJournal !== null &&
      localStorage.getItem(legacyKey) === coveredJournal &&
      typeof journal?.writtenAt === "number" &&
      journal.writtenAt <= snapshot.writtenAt
    )
      localStorage.removeItem(legacyKey);
  } catch {
    /* A legacy-storage failure cannot invalidate committed drafts. */
  }
}

export function mergeDurableEditRecovery(
  state: WorkbenchState,
  snapshot = bootSnapshot,
): WorkbenchState {
  if (!snapshot) return state;
  const buffers = { ...snapshot.buffers };
  for (const [path, buffer] of Object.entries(state.ide.buffers)) {
    if (
      buffer.content !== buffer.savedContent &&
      Date.parse(buffer.updatedAt) > snapshot.writtenAt
    )
      buffers[path] = buffer;
  }
  const tabs = (values: WorkbenchState["ide"]["tabs"]) =>
    values.map((tab) => ({
      ...tab,
      dirty: Boolean(buffers[tab.path]),
      ...(buffers[tab.path] ? { pinned: true, preview: false } : {}),
    }));
  const recoveredTabs = Object.keys(buffers)
    .filter((path) => !state.ide.tabs.some((tab) => tab.path === path))
    .map((path) => ({
      path,
      title: path.slice(path.lastIndexOf("/") + 1),
      dirty: true,
      pinned: true,
      preview: false,
      groupId: state.ide.layout.groups[0]?.id,
    }));
  return {
    ...state,
    ide: {
      ...state.ide,
      buffers,
      tabs: [...tabs(state.ide.tabs), ...recoveredTabs],
      activePath: state.ide.activePath ?? recoveredTabs[0]?.path,
      layout: {
        ...state.ide.layout,
        groups: state.ide.layout.groups.map((group, index) => ({
          ...group,
          tabs: [...tabs(group.tabs), ...(index === 0 ? recoveredTabs : [])],
          activePath:
            group.activePath ??
            (index === 0 ? recoveredTabs[0]?.path : undefined),
        })),
      },
    },
  };
}

export function recoverDurableEditRecovery(
  state: WorkbenchState,
): WorkbenchState {
  // A synchronous symbol-edit journal may have committed after the last IDB transaction.
  try {
    const journal = JSON.parse(
      localStorage.getItem("gyro.workspace-edit-recovery.v1") ?? "null",
    );
    if (
      bootSnapshot &&
      journal &&
      (validateDraftSnapshot(journal).writtenAt > bootSnapshot.writtenAt ||
        (journal.writtenAt === bootSnapshot.writtenAt &&
          typeof journal.revision === "string" &&
          journal.revision !== bootSnapshot.legacyJournalRevision))
    )
      return state;
  } catch {
    /* The validated durable store can recover a broken legacy journal. */
  }
  return mergeDurableEditRecovery(state);
}
