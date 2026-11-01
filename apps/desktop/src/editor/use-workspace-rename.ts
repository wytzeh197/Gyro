import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { editorBufferRecoveryCapacity, prepareEditorBufferBatch, isWorkspaceTrusted, workspaceRootForPath,
  type EditorBuffer, type WorkbenchAction, type WorkspaceFileContent, type EditorBufferBatchUpdate } from "@gyro-dev/ui";
import { filePathFromUri } from "./document-uri";
import { prepareWorkspaceEdit, workspaceEditTargetUris, type PreparedWorkspaceEdit, type WorkspaceEditSnapshot } from "./workspace-edits";
import { hasEditRecovery, readEditRecovery, writeEditRecovery } from "./edit-recovery";

type Position = { lineNumber: number; column: number };
type RenameDraft = {
  path: string; root: string; position: Position; original: string; name: string; busy: boolean; error?: string;
  plan?: PreparedWorkspaceEdit; snapshots?: Record<string, EditorBuffer>; versions?: Record<string, number | undefined>;
  introduced?: Record<string, EditorBuffer>;
};
type RenameTransaction = { files: PreparedWorkspaceEdit["files"]; originals: Record<string, EditorBuffer>; introduced: Record<string, EditorBuffer> };
type TemporaryBuffer = { baseline: EditorBuffer; owner: number };
const MAX_TARGET_DISCOVERY_PASSES = 3;

export function editorBufferFromFile(file: WorkspaceFileContent): EditorBuffer {
  return { path: file.path, content: file.content, savedContent: file.content, contentHash: file.contentHash,
    sizeBytes: file.sizeBytes, truncated: file.truncated, status: "ready", updatedAt: new Date().toISOString() };
}

function nameAt(content: string, position: Position) {
  const line = content.split(/\r\n|\n|\r/)[position.lineNumber - 1] ?? "";
  const cursor = position.column - 1;
  return [...line.matchAll(/[\p{L}\p{N}_$]+/gu)].find(match => match.index! <= cursor && match.index! + match[0].length >= cursor)?.[0] ?? "";
}

export function useWorkspaceRename(options: {
  buffers: Record<string, EditorBuffer>;
  roots: string[];
  trust: Record<string, "trusted" | "restricted">;
  read(path: string, root: string): Promise<WorkspaceFileContent>;
  request(path: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  version(path: string): number | undefined;
  capabilities(path: string): Record<string, unknown> | undefined;
  synchronize(path: string, sourcePath?: string): Promise<void>;
  isOpen?(path: string): boolean;
  dispatch(action: WorkbenchAction): void;
  save(path: string): Promise<boolean | void>;
  notify(message: string): void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const buffers = useRef(options.buffers);
  buffers.current = options.buffers;
  const operation = useRef(0);
  const [draft, setDraft] = useState<RenameDraft>();
  const [transaction, setTransaction] = useState<RenameTransaction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recoveryError = useRef<string>();
  const saving = useRef(false);
  const temporary = useRef(new Map<string, TemporaryBuffer>());

  const commitBatch = useCallback((updates: EditorBufferBatchUpdate[], recover = false) => {
    const current = latest.current;
    const next = prepareEditorBufferBatch(buffers.current, updates);
    if (recover) writeEditRecovery(next);
    flushSync(() => current.dispatch({ type: "ide-apply-buffer-batch", updates }));
    const actual = latest.current.buffers;
    const acknowledged = updates.every(update => update.buffer
      ? actual[update.path]?.content === update.buffer.content && actual[update.path]?.savedContent === update.buffer.savedContent && actual[update.path]?.contentHash === update.buffer.contentHash
      : actual[update.path] === undefined);
    if (!acknowledged) {
      if (recover) writeEditRecovery(actual);
      throw new Error("A buffer changed before the workspace edit was applied. Try again.");
    }
    buffers.current = actual;
    return actual;
  }, []);

  const releaseTemporary = useCallback((owner?: number, paths?: ReadonlySet<string>) => {
    const candidates = [...temporary.current.entries()].filter(([path, value]) =>
      (owner === undefined || value.owner === owner) && (!paths || paths.has(path)));
    const updates: EditorBufferBatchUpdate[] = [];
    for (const [path, { baseline }] of candidates) {
      const live = buffers.current[path];
      // Without an ownership port, retain the document conservatively.
      if (!live || !latest.current.isOpen || latest.current.isOpen(path) ||
        live.content !== live.savedContent || live.content !== baseline.content ||
        live.savedContent !== baseline.savedContent || live.contentHash !== baseline.contentHash) continue;
      updates.push({ path, expectedContent: live.content, expectedHash: live.contentHash,
        expectedSavedContent: live.savedContent, buffer: null });
    }
    try {
      // Removing clean drafts leaves the durable dirty set unchanged and must
      // remain possible even if recovery storage is temporarily unavailable.
      if (updates.length) commitBatch(updates);
      for (const [path] of candidates) temporary.current.delete(path);
    } catch (failure) { latest.current.notify(`Could not release temporary rename files. ${String(failure)}`); }
  }, [commitBatch]);

  const claimTemporary = (owner: number) => {
    for (const value of temporary.current.values()) value.owner = owner;
  };

  useEffect(() => {
    if (!hasEditRecovery()) return;
    try { writeEditRecovery(options.buffers); recoveryError.current = undefined; }
    catch (failure) { const message = String(failure); if (message !== recoveryError.current) { recoveryError.current = message; setError(message); } }
  }, [options.buffers]);
  useEffect(() => {
    try { readEditRecovery(); } catch (failure) { setError(String(failure)); }
    return () => { operation.current += 1; temporary.current.clear(); };
  }, []);

  const begin = useCallback(async (path: string, position: Position) => {
    releaseTemporary();
    const current = latest.current;
    const root = workspaceRootForPath(current.roots, path);
    const buffer = buffers.current[path];
    if (!root || !buffer || !isWorkspaceTrusted(current.trust, root) || buffer.truncated) {
      current.notify("Open an editable file in a trusted workspace to rename a symbol."); return;
    }
    const token = ++operation.current;
    const initial = nameAt(buffer.content, position);
    setDraft({ path, root, position, original: buffer.content, name: initial, busy: true });
    try {
      // Flush dirty text and ensure the server is started before reading capabilities.
      await current.request(path, "$/gyro/poll", {});
      const provider = current.capabilities(path)?.renameProvider;
      if (!provider) throw new Error("The language server does not support rename for this file.");
      let name = initial;
      if (typeof provider === "object" && provider && "prepareProvider" in provider && provider.prepareProvider) {
        const prepared = await current.request(path, "textDocument/prepareRename", { position: { line: position.lineNumber - 1, character: position.column - 1 } });
        if (!prepared) throw new Error("This symbol cannot be renamed.");
        if (typeof prepared === "object" && "placeholder" in prepared && typeof prepared.placeholder === "string") name = prepared.placeholder;
      }
      if (operation.current === token) setDraft({ path, root, position, original: buffer.content, name, busy: false });
    } catch (failure) {
      if (operation.current === token) setDraft(value => value && { ...value, busy: false, error: `Could not prepare rename. ${String(failure)}` });
    }
  }, [releaseTemporary]);

  const preview = useCallback(async (name: string) => {
    if (!draft || draft.busy) return;
    const token = ++operation.current;
    claimTemporary(token);
    const pending = { ...draft, name, busy: true, error: undefined, plan: undefined, snapshots: undefined, versions: undefined, introduced: undefined };
    setDraft(pending);
    try {
      const assertSource = () => {
        if (operation.current !== token) throw new Error("Rename cancelled.");
        if (buffers.current[draft.path]?.content !== draft.original) throw new Error("The source changed. Close this preview and try again.");
        const root = workspaceRootForPath(latest.current.roots, draft.path);
        if (root !== draft.root || !isWorkspaceTrusted(latest.current.trust, root)) throw new Error("The workspace changed. Try again.");
      };
      const params = {
        position: { line: draft.position.lineNumber - 1, character: draft.position.column - 1 }, newName: name,
      };
      assertSource();
      // The discovery response identifies targets only. Its ranges are never
      // applied to documents read after that response.
      const discovered = await latest.current.request(draft.path, "textDocument/rename", params);
      assertSource();
      const known = new Set(workspaceEditTargetUris(discovered));
      if (!known.size) throw new Error("The language server returned no changes for this name.");
      for (let pass = 0; pass < MAX_TARGET_DISCOVERY_PASSES; pass += 1) {
        const originals: Record<string, EditorBuffer> = {};
        const snapshots: Record<string, WorkspaceEditSnapshot> = {};
        const hydrate: EditorBufferBatchUpdate[] = [];
        for (const uri of known) {
          assertSource();
          const path = filePathFromUri(uri);
          const current = latest.current;
          const root = path ? workspaceRootForPath(current.roots, path) : undefined;
          if (!path || !root || !isWorkspaceTrusted(current.trust, root)) throw new Error("The rename includes a file outside the trusted workspace folders.");
          if (root !== draft.root) throw new Error("Rename across workspace folders is not supported because their language servers do not share unsaved changes. Open the affected files under one workspace folder and try again.");
          const previous = buffers.current[path];
          // Native reads validate symlinks, regular text and limits before any
          // background buffer is introduced.
          const disk = await current.read(path, root);
          assertSource();
          if (disk.truncated) throw new Error(`Load the complete file before renaming: ${path}`);
          const live = buffers.current[path];
          if ((previous && (!live || previous.content !== live.content || previous.savedContent !== live.savedContent || previous.contentHash !== live.contentHash)) || (!previous && live))
            throw new Error(`The buffer changed while loading rename targets: ${path}`);
          if (live && live.contentHash !== disk.contentHash) throw new Error(`The file changed on disk: ${path}`);
          const original = { ...(live ?? editorBufferFromFile(disk)) };
          originals[path] = original;
          snapshots[uri] = { uri, path, content: original.content, diskHash: disk.contentHash };
          if (!live) hydrate.push({ path, buffer: original });
        }
        assertSource();
        if (hydrate.length) {
          commitBatch(hydrate);
          for (const update of hydrate) temporary.current.set(update.path, { baseline: { ...update.buffer! }, owner: token });
        }
        await Promise.all(Object.values(snapshots).map(snapshot => latest.current.synchronize(snapshot.path, draft.path)));
        assertSource();
        const versions: Record<string, number | undefined> = {};
        let frozenVersions = false;
        const assertBaselines = () => {
          assertSource();
          for (const snapshot of Object.values(snapshots)) {
            const original = originals[snapshot.path]!;
            const live = buffers.current[snapshot.path];
            const root = workspaceRootForPath(latest.current.roots, snapshot.path);
            if (root !== draft.root || !isWorkspaceTrusted(latest.current.trust, root)) throw new Error("The workspace changed. Try again.");
            if (!live || live.content !== snapshot.content || live.savedContent !== original.savedContent || live.contentHash !== snapshot.diskHash)
              throw new Error(`The buffer changed: ${snapshot.path}`);
            if (frozenVersions && latest.current.version(snapshot.path) !== snapshot.version)
              throw new Error(`The document version changed: ${snapshot.path}`);
          }
        };
        assertBaselines();
        for (const snapshot of Object.values(snapshots)) {
          const version = latest.current.version(snapshot.path);
          versions[snapshot.path] = version;
          snapshot.version = version;
        }
        frozenVersions = true;
        // All final ranges now refer to snapshots established and synchronized
        // before this request, including files that were initially unopened.
        const raw = await latest.current.request(draft.path, "textDocument/rename", params);
        assertBaselines();
        const finalTargets = workspaceEditTargetUris(raw);
        const additional = finalTargets.filter(uri => !known.has(uri));
        if (additional.length) {
          for (const uri of additional) known.add(uri);
          continue;
        }
        for (const snapshot of Object.values(snapshots)) {
          const root = workspaceRootForPath(latest.current.roots, snapshot.path)!;
          const disk = await latest.current.read(snapshot.path, root);
          assertBaselines();
          if (disk.truncated || disk.contentHash !== snapshot.diskHash) throw new Error(`The file changed on disk: ${snapshot.path}`);
        }
        assertBaselines();
        const plan = prepareWorkspaceEdit(raw, snapshots);
        if (!plan.files.length) throw new Error("The language server returned no changes for this name.");
        const projected = { ...buffers.current };
        for (const file of plan.files) projected[file.path] = { ...originals[file.path]!, content: file.after, status: "dirty" };
        const capacity = editorBufferRecoveryCapacity(projected);
        if (!capacity.ok) throw new Error(capacity.reason);
        const affected = new Set(plan.files.map(file => file.path));
        releaseTemporary(token, new Set([...temporary.current.keys()].filter(path => !affected.has(path))));
        assertSource();
        const introduced = Object.fromEntries([...temporary.current.entries()]
          .filter(([path, value]) => value.owner === token && affected.has(path))
          .map(([path, value]) => [path, value.baseline]));
        setDraft({ ...draft, name, plan, snapshots: originals, versions, introduced, busy: false });
        return;
      }
      throw new Error("The rename target set kept changing. Try again after the workspace settles.");
    } catch (failure) {
      releaseTemporary(token);
      if (operation.current === token) setDraft({ ...pending, busy: false, error: `Could not preview rename. ${String(failure)}` });
    }
  }, [draft, commitBatch, releaseTemporary]);

  const apply = useCallback(async () => {
    if (!draft?.plan || !draft.snapshots || draft.busy) return;
    const token = ++operation.current;
    claimTemporary(token);
    setDraft({ ...draft, busy: true, error: undefined });
    try {
      const current = latest.current;
      if (buffers.current[draft.path]?.content !== draft.original) throw new Error("The source changed. Close this preview and try again.");
      if (workspaceRootForPath(current.roots, draft.path) !== draft.root) throw new Error("The workspace changed. Try again.");
      const updates: EditorBufferBatchUpdate[] = [];
      for (const file of draft.plan.files) {
        const root = workspaceRootForPath(current.roots, file.path);
        if (!root || !isWorkspaceTrusted(current.trust, root)) throw new Error("A workspace folder is no longer trusted.");
        if (root !== draft.root) throw new Error("Rename across workspace folders is not supported because their language servers do not share unsaved changes.");
        await latest.current.synchronize(file.path, draft.path);
        if (operation.current !== token) return;
        const disk = await current.read(file.path, root);
        if (operation.current !== token) return;
        if (disk.contentHash !== file.diskHash) throw new Error(`The file changed on disk: ${file.path}`);
        const live = buffers.current[file.path];
        if (!live || live.content !== file.before || live.savedContent !== draft.snapshots[file.path]?.savedContent || live.contentHash !== file.diskHash)
          throw new Error(`The buffer changed: ${file.path}`);
        if (current.version(file.path) !== draft.versions?.[file.path]) throw new Error(`The document version changed: ${file.path}`);
        const original = draft.snapshots[file.path]!;
        updates.push({ path: file.path, expectedContent: live.content, expectedHash: live.contentHash, expectedSavedContent: live.savedContent,
          buffer: { ...original, content: file.after, sizeBytes: new TextEncoder().encode(file.after).length,
            status: file.after === original.savedContent ? "ready" : "dirty", updatedAt: new Date().toISOString() } });
      }
      if (operation.current !== token) return;
      if (buffers.current[draft.path]?.content !== draft.original) throw new Error("The source changed. Close this preview and try again.");
      if (workspaceRootForPath(latest.current.roots, draft.path) !== draft.root) throw new Error("The workspace changed. Try again.");
      for (const file of draft.plan.files) {
        const root = workspaceRootForPath(latest.current.roots, file.path);
        if (root !== draft.root || !isWorkspaceTrusted(latest.current.trust, root)) throw new Error("The workspace changed. Try again.");
        if (latest.current.version(file.path) !== draft.versions?.[file.path]) throw new Error(`The document version changed: ${file.path}`);
      }
      commitBatch(updates, true);
      setTransaction({ files: draft.plan.files, originals: draft.snapshots, introduced: draft.introduced ?? {} });
      for (const [path, value] of temporary.current) if (value.owner === token) temporary.current.delete(path);
      setDraft(undefined); setError(undefined);
      operation.current += 1;
    } catch (failure) {
      if (operation.current === token) setDraft({ ...draft, busy: false, error: `Could not apply rename. ${String(failure)}` });
    }
  }, [draft, commitBatch]);

  const undo = useCallback(() => {
    if (!transaction) return;
    try {
      const updates: EditorBufferBatchUpdate[] = transaction.files.map(file => {
        const live = buffers.current[file.path];
        if (!live || live.content !== file.after) throw new Error(`The file has newer edits: ${file.path}`);
        const introduced = transaction.introduced[file.path];
        const remove = introduced && latest.current.isOpen && !latest.current.isOpen(file.path) &&
          file.before === introduced.content && live.savedContent === introduced.savedContent && live.contentHash === introduced.contentHash;
        return { path: file.path, expectedContent: live.content, expectedHash: live.contentHash, expectedSavedContent: live.savedContent,
          buffer: remove ? null : { ...live, content: file.before, status: file.before === live.savedContent ? "ready" as const : "dirty" as const,
            updatedAt: new Date().toISOString(), sizeBytes: new TextEncoder().encode(file.before).length } };
      });
      commitBatch(updates, true);
      setTransaction(undefined); setError(undefined);
    } catch (failure) { setError(`Could not undo rename. ${String(failure)}`); }
  }, [transaction, commitBatch]);

  const saveAll = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const paths = Object.values(buffers.current).filter(buffer => buffer.content !== buffer.savedContent && workspaceRootForPath(latest.current.roots, buffer.path)).map(buffer => buffer.path);
      const failed: string[] = [];
      for (const path of paths) {
        try { if (await latest.current.save(path) === false) failed.push(path); }
        catch { failed.push(path); }
      }
      if (failed.length) setError(`Could not save ${failed.length} ${failed.length === 1 ? "file" : "files"}. Unsaved changes are preserved: ${failed.join(", ")}`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, []);
  const paths = Object.values(options.buffers).filter(buffer => buffer.content !== buffer.savedContent && workspaceRootForPath(options.roots, buffer.path)).map(buffer => buffer.path);
  return { draft, begin, preview, apply, cancel: () => { operation.current += 1; setDraft(undefined); releaseTemporary(); },
    undo, saveAll, paths, canUndo: Boolean(transaction), busy, error };
}
