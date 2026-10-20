// Builds the in-memory IDE evidence snapshot the chat capability bridge reads.
//
// The turn snapshot still omits editor text. This copy lists every open tab in
// the project and attaches complete unsaved text while the serialized snapshot
// stays inside the native capability result limit (128 KiB). A clipped buffer
// is not usable: the broker rejects truncated live text instead of returning a
// range, so content is included whole or not at all.

import type {
  EditorSelection,
  WorkspaceContextSnapshot,
} from "@gyro-dev/ui";

/** Native `MAX_CAPABILITY_RESULT_BYTES`. The broker rejects a larger snapshot. */
export const WORKSPACE_EVIDENCE_BYTE_LIMIT = 128 * 1024;

/**
 * Room for the Rust struct to re-encode omitted optional fields as null and
 * for JSON key overhead the character estimate does not count.
 */
const SERIALIZATION_MARGIN_BYTES = 8 * 1024;

const CONTENT_FIELD_OVERHEAD = 16;

export type LiveEditorBufferSource = {
  content: string;
  savedContent: string;
  contentHash?: string;
  updatedAt: string;
  /** The editor did not load the whole file, so `content` is not the document. */
  truncated?: boolean;
};

type BufferDraft = {
  path: string;
  dirty: boolean;
  diskHash?: string;
  documentVersion?: string;
  /** Editor loaded a partial document. Live text cannot be disclosed from it. */
  editorTruncated: boolean;
  /** Complete document text, when the editor has it. */
  text?: string;
  role: "active" | "dirty" | "clean";
};

type Attachment =
  | { kind: "buffer"; index: number }
  | { kind: "selection" };

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function jsonStringBytes(value: string) {
  return utf8Bytes(JSON.stringify(value));
}

export function workspaceContextRelativePath(path: string, root: string) {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return ".";
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

function draftBuffer(
  absolutePath: string,
  root: string,
  activePath: string | undefined,
  source: LiveEditorBufferSource | undefined,
): BufferDraft {
  const path = workspaceContextRelativePath(absolutePath, root);
  if (!source) {
    return {
      path,
      dirty: false,
      editorTruncated: false,
      role: absolutePath === activePath ? "active" : "clean",
    };
  }
  const dirty = source.content !== source.savedContent;
  return {
    path,
    dirty,
    diskHash: source.contentHash,
    documentVersion: source.updatedAt,
    editorTruncated: source.truncated === true,
    text: source.truncated === true ? undefined : source.content,
    role:
      absolutePath === activePath ? "active" : dirty ? "dirty" : "clean",
  };
}

function bufferEntry(draft: BufferDraft, includeContent: boolean) {
  return {
    path: draft.path,
    dirty: draft.dirty,
    ...(draft.diskHash ? { diskHash: draft.diskHash } : {}),
    ...(draft.documentVersion
      ? { documentVersion: draft.documentVersion }
      : {}),
    ...(draft.editorTruncated ? { truncated: true as const } : {}),
    ...(includeContent && draft.text !== undefined
      ? { content: draft.text }
      : {}),
  };
}

/**
 * Evidence the capability broker keeps for one project.
 *
 * `buffers` is every open tab in `context.workspaceKey`, at most 64. Content
 * is attached, in order, for the active buffer, the active selection, and
 * other dirty buffers, and only when that text fits in full. Clean buffers
 * stay metadata so a disk read remains the honest source. Opening a file still
 * does not copy its text into the turn snapshot; callers pass that slimmer
 * snapshot in as `context`.
 */
export function workspaceContextWithLiveEditor(
  context: WorkspaceContextSnapshot,
  activePath: string | undefined,
  buffers: Readonly<Record<string, LiveEditorBufferSource | undefined>>,
  selection: EditorSelection | undefined,
  tabs: readonly string[],
): WorkspaceContextSnapshot {
  const root = context.workspaceKey.replace(/\/+$/, "");
  const inRoot = (path: string) => path.startsWith(`${root}/`);
  const seen = new Set<string>();
  const tabPaths: string[] = [];
  for (const path of tabs) {
    if (!inRoot(path) || seen.has(path)) continue;
    seen.add(path);
    tabPaths.push(path);
    if (tabPaths.length === 64) break;
  }
  if (activePath && inRoot(activePath) && !seen.has(activePath)) {
    if (tabPaths.length >= 64) tabPaths.pop();
    tabPaths.unshift(activePath);
  }

  const drafts = tabPaths.map((path) =>
    draftBuffer(path, root, activePath, buffers[path]),
  );
  const activeIndex = drafts.findIndex((draft) => draft.role === "active");
  const activeRelative =
    activeIndex >= 0 ? drafts[activeIndex]?.path : undefined;
  const selectionCandidate =
    selection &&
    activePath &&
    selection.path === activePath &&
    activeRelative
      ? { ...selection, path: activeRelative }
      : undefined;

  const base: WorkspaceContextSnapshot = {
    ...context,
    revision: Date.now(),
    activePath: activeRelative,
    visibleTabs: drafts.map((draft) => draft.path),
    selection: undefined,
    buffers: drafts.map((draft) => bufferEntry(draft, false)),
  };
  let remaining =
    WORKSPACE_EVIDENCE_BYTE_LIMIT -
    SERIALIZATION_MARGIN_BYTES -
    utf8Bytes(JSON.stringify(base));

  const attached: Attachment[] = [];
  const included = new Set<number>();

  const take = (cost: number, attachment: Attachment) => {
    if (cost > remaining) return false;
    remaining -= cost;
    attached.push(attachment);
    if (attachment.kind === "buffer") included.add(attachment.index);
    return true;
  };

  if (activeIndex >= 0) {
    const text = drafts[activeIndex]?.text;
    if (text !== undefined) {
      take(jsonStringBytes(text) + CONTENT_FIELD_OVERHEAD, {
        kind: "buffer",
        index: activeIndex,
      });
    }
  }
  let includeSelection = false;
  if (selectionCandidate) {
    includeSelection = take(
      jsonStringBytes(selectionCandidate.text) + CONTENT_FIELD_OVERHEAD,
      { kind: "selection" },
    );
  }
  drafts.forEach((draft, index) => {
    if (draft.role !== "dirty" || draft.text === undefined) return;
    take(jsonStringBytes(draft.text) + CONTENT_FIELD_OVERHEAD, {
      kind: "buffer",
      index,
    });
  });

  let snapshot: WorkspaceContextSnapshot = {
    ...base,
    selection: includeSelection ? selectionCandidate : undefined,
    buffers: drafts.map((draft, index) =>
      bufferEntry(draft, included.has(index)),
    ),
  };

  // The estimate can under-count escaping and struct fields. Drop the
  // lowest-priority text until the payload the shell sends is under the cap.
  while (
    utf8Bytes(JSON.stringify(snapshot)) >
      WORKSPACE_EVIDENCE_BYTE_LIMIT - 2 * 1024 &&
    attached.length > 0
  ) {
    const last = attached.pop();
    if (!last) break;
    if (last.kind === "selection") {
      includeSelection = false;
    } else {
      included.delete(last.index);
    }
    snapshot = {
      ...base,
      selection: includeSelection ? selectionCandidate : undefined,
      buffers: drafts.map((draft, index) =>
        bufferEntry(draft, included.has(index)),
      ),
    };
  }

  return snapshot;
}
