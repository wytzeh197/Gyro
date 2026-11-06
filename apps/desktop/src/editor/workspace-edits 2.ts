/** Pure planning for text-only LSP edits. The caller supplies authorized snapshots. */
export type WorkspaceEditSnapshot = {
  uri: string;
  path: string;
  content: string;
  version?: number;
  diskHash?: string;
};

export type PreparedWorkspaceEditFile = {
  uri: string;
  path: string;
  before: string;
  after: string;
  version?: number;
  diskHash?: string;
};

export type PreparedWorkspaceEdit = {
  files: PreparedWorkspaceEditFile[];
  editCount: number;
};

type TextEditGroup = { uri: string; edits: unknown[]; version?: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function canonicalWorkspaceEditUri(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("An edit target has no file URI.");
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("An edit target has an invalid file URI.");
  }
  if (
    uri.protocol !== "file:" ||
    (uri.hostname && uri.hostname !== "localhost") ||
    uri.search ||
    uri.hash ||
    !uri.pathname.startsWith("/")
  ) {
    throw new Error("Workspace edits support local file URIs only.");
  }
  let path: string;
  try {
    path = decodeURIComponent(uri.pathname);
  } catch {
    throw new Error("An edit target has invalid URI escaping.");
  }
  if (path.includes("\0") || path.includes("\\")) {
    throw new Error("An edit target has an invalid path.");
  }
  // URL serializes localhost as the empty authority and canonicalizes dot segments.
  return new URL(
    `file://${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}`,
  ).href;
}

function editGroups(raw: unknown): TextEditGroup[] {
  const edit = record(raw);
  if (!edit)
    throw new Error("The language server returned an invalid workspace edit.");
  const groups: TextEditGroup[] = [];
  if (edit.changes !== undefined) {
    const changes = record(edit.changes);
    if (!changes) throw new Error("Workspace edit changes must be a URI map.");
    const targets = new Set<string>();
    for (const [target, edits] of Object.entries(changes)) {
      if (!Array.isArray(edits))
        throw new Error("A file edit list is invalid.");
      const uri = canonicalWorkspaceEditUri(target);
      if (targets.has(uri))
        throw new Error(
          "A workspace edit contains duplicate file URI aliases.",
        );
      targets.add(uri);
      groups.push({ uri, edits });
    }
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) {
      throw new Error("Workspace documentChanges must be an array.");
    }
    for (const rawChange of edit.documentChanges) {
      const change = record(rawChange);
      if (!change || change.kind !== undefined) {
        throw new Error(
          "Create, rename, and delete file operations are not supported.",
        );
      }
      const document = record(change.textDocument);
      if (!document || !Array.isArray(change.edits)) {
        throw new Error("A text document edit is invalid.");
      }
      const version = document.version;
      if (
        version !== undefined &&
        version !== null &&
        !Number.isSafeInteger(version)
      ) {
        throw new Error("A text document edit has an invalid version.");
      }
      groups.push({
        uri: canonicalWorkspaceEditUri(document.uri),
        edits: change.edits,
        ...(typeof version === "number" ? { version } : {}),
      });
    }
  }
  if (edit.changes === undefined && edit.documentChanges === undefined) {
    throw new Error("The language server returned no text edits.");
  }
  return groups;
}

/** Discover every target before reading it. Any unsupported operation rejects the whole edit. */
export function workspaceEditTargetUris(raw: unknown): string[] {
  return [...new Set(editGroups(raw).map((group) => group.uri))];
}

function textLineOffsets(content: string) {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  const newline = /\r\n|\r|\n/g;
  for (const match of content.matchAll(newline)) {
    lines.push({ start, end: match.index! });
    start = match.index! + match[0].length;
  }
  lines.push({ start, end: content.length });
  return lines;
}

function positionOffset(
  content: string,
  lines: Array<{ start: number; end: number }>,
  value: unknown,
) {
  const position = record(value);
  const line = position?.line;
  const character = position?.character;
  if (
    typeof line !== "number" ||
    !Number.isSafeInteger(line) ||
    line < 0 ||
    typeof character !== "number" ||
    !Number.isSafeInteger(character) ||
    character < 0 ||
    !lines[line] ||
    character > lines[line]!.end - lines[line]!.start
  )
    throw new Error(
      "An edit range is outside the document's UTF-16 positions.",
    );
  const offset = lines[line]!.start + character;
  const preceding = content.charCodeAt(offset - 1);
  const following = content.charCodeAt(offset);
  if (
    preceding >= 0xd800 &&
    preceding <= 0xdbff &&
    following >= 0xdc00 &&
    following <= 0xdfff
  ) {
    throw new Error("An edit range splits a UTF-16 surrogate pair.");
  }
  return offset;
}

function applyTextEdits(content: string, rawEdits: unknown[]): string {
  const lines = textLineOffsets(content);
  const edits = rawEdits
    .map((value, index) => {
      const edit = record(value);
      const range = record(edit?.range);
      if (!edit || !range || typeof edit.newText !== "string") {
        throw new Error("The language server returned a malformed text edit.");
      }
      const start = positionOffset(content, lines, range.start);
      const end = positionOffset(content, lines, range.end);
      if (start > end) throw new Error("An edit range is reversed.");
      return { start, end, text: edit.newText, index };
    })
    .sort((a, b) => a.start - b.start || a.index - b.index);
  let cursor = 0;
  let result = "";
  for (const edit of edits) {
    if (edit.start < cursor)
      throw new Error("Workspace edits contain overlapping ranges.");
    result += content.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + content.slice(cursor);
}

export function prepareWorkspaceEdit(
  raw: unknown,
  snapshots: Readonly<Record<string, WorkspaceEditSnapshot>>,
): PreparedWorkspaceEdit {
  const files = new Map<string, PreparedWorkspaceEditFile>();
  const paths = new Map<string, string>();
  let editCount = 0;
  for (const group of editGroups(raw)) {
    const snapshot = snapshots[group.uri];
    if (
      !snapshot ||
      canonicalWorkspaceEditUri(snapshot.uri) !== group.uri ||
      typeof snapshot.path !== "string" ||
      !snapshot.path ||
      typeof snapshot.content !== "string" ||
      (snapshot.version !== undefined &&
        !Number.isSafeInteger(snapshot.version)) ||
      (snapshot.diskHash !== undefined && typeof snapshot.diskHash !== "string")
    ) {
      throw new Error(
        "A workspace edit target has no authorized document snapshot.",
      );
    }
    if (paths.has(snapshot.path) && paths.get(snapshot.path) !== group.uri) {
      throw new Error(
        "Multiple edit target URIs resolve to the same buffer path.",
      );
    }
    paths.set(snapshot.path, group.uri);
    if (group.version !== undefined && group.version !== snapshot.version) {
      throw new Error(
        "The document changed while its workspace edit was prepared.",
      );
    }
    const file = files.get(group.uri) ?? {
      uri: group.uri,
      path: snapshot.path,
      before: snapshot.content,
      after: snapshot.content,
      version: snapshot.version,
      diskHash: snapshot.diskHash,
    };
    file.after = applyTextEdits(file.after, group.edits);
    files.set(group.uri, file);
    editCount += group.edits.length;
  }
  return {
    files: [...files.values()].filter((file) => file.before !== file.after),
    editCount,
  };
}
