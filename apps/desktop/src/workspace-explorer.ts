import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFile } from "@gyro-dev/ui";

type DirectoryListing = { path: string; files: WorkspaceFile[] };

// Listings replace a directory's direct children. Walking from the current roots
// also drops cached descendants of deleted/renamed folders or previous projects.
export function mergeExplorerDirectories(
  files: WorkspaceFile[],
  listings: DirectoryListing[],
) {
  const children = new Map<string, WorkspaceFile[]>();
  for (const file of files) {
    if (file.isWorkspaceRoot) continue;
    const parent = file.path.slice(0, file.path.lastIndexOf("/"));
    const siblings = children.get(parent) ?? [];
    siblings.push(file);
    children.set(parent, siblings);
  }
  for (const listing of listings) children.set(listing.path, listing.files);
  const result: WorkspaceFile[] = [];
  const visit = (file: WorkspaceFile) => {
    result.push(file);
    if (file.kind !== "directory") return;
    const entries = [...(children.get(file.path) ?? [])].sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.path.localeCompare(b.path),
    );
    entries.forEach(visit);
  };
  files.filter((file) => file.isWorkspaceRoot).forEach(visit);
  return result.length ? result : files;
}

export function useWorkspaceExplorerFiles(
  files: WorkspaceFile[],
  loadDirectory: ((path: string) => Promise<WorkspaceFile[]>) | undefined,
  onError: (path: string, error: unknown) => void,
) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [listings, setListings] = useState<DirectoryListing[]>([]);
  const roots = files
    .filter((file) => file.isWorkspaceRoot)
    .map((file) => file.path);
  const rootKey = roots.join("\n");
  const explorerFiles = useMemo(
    () => mergeExplorerDirectories(files, listings),
    [files, listings],
  );
  const directoryKey = explorerFiles
    .filter((file) => {
      if (file.kind !== "directory" || !expanded.includes(file.path))
        return false;
      if (file.isWorkspaceRoot) return true;
      const root =
        file.workspacePath ??
        roots.find((path) => file.path.startsWith(`${path}/`));
      if (!root) return false;
      let parent = file.path.slice(0, file.path.lastIndexOf("/"));
      while (parent.length >= root.length) {
        if (!expanded.includes(parent)) return false;
        parent = parent.slice(0, parent.lastIndexOf("/"));
      }
      return true;
    })
    .map((file) => file.path)
    .join("\n");

  useEffect(() => {
    if (!loadDirectory) return;
    let cancelled = false;
    let pending = false;
    const failed = new Set<string>();
    const directories = directoryKey ? directoryKey.split("\n") : [];
    const refresh = async () => {
      if (pending || !directories.length) return;
      pending = true;
      const results = await Promise.allSettled(directories.map(loadDirectory));
      pending = false;
      if (cancelled) return;
      const updated: DirectoryListing[] = [];
      results.forEach((result, index) => {
        const path = directories[index];
        if (!path) return;
        if (result.status === "fulfilled") {
          failed.delete(path);
          updated.push({ path, files: result.value });
        } else if (!failed.has(path)) {
          failed.add(path);
          onError(path, result.reason);
        }
      });
      setListings((current) => {
        const byPath = new Map(
          current
            .filter((entry) =>
              roots.some(
                (root) =>
                  entry.path === root || entry.path.startsWith(`${root}/`),
              ),
            )
            .map((entry) => [entry.path, entry]),
        );
        for (const entry of updated) byPath.set(entry.path, entry);
        const next = [...byPath.values()];
        return JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next;
      });
    };
    void refresh();
    // Keep open folders current even when native file watching is unavailable.
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [directoryKey, files, rootKey, loadDirectory, onError]);
  return { explorerFiles, onExpandedDirectoriesChange: setExpanded };
}
