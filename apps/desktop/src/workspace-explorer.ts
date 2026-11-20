import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFile } from "@gyro-dev/ui";
import { workspaceExplorerRootEntryGroup } from "@gyro-dev/ui/workspace-project";

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
    const groupRank = (entry: WorkspaceFile) => {
      if (!file.isWorkspaceRoot) return entry.kind === "directory" ? 0 : 1;
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const group = workspaceExplorerRootEntryGroup(name);
      if (group === "generated") return entry.kind === "directory" ? 4 : 5;
      if (group === "configuration") return entry.kind === "directory" ? 2 : 3;
      return entry.kind === "directory" ? 0 : 1;
    };
    const entries = [...(children.get(file.path) ?? [])].sort(
      (a, b) => groupRank(a) - groupRank(b) || a.path.localeCompare(b.path),
    );
    entries.forEach(visit);
  };
  files.filter((file) => file.isWorkspaceRoot).forEach(visit);
  return result.length ? result : files;
}

// A poll usually returns exactly what is already cached. Comparing entries
// field by field is exact, exits on the first difference, and — unlike
// comparing two `JSON.stringify` snapshots of every open folder — allocates
// nothing while the tree is unchanged.
function sameListing(left: DirectoryListing, right: DirectoryListing) {
  if (left.path !== right.path || left.files.length !== right.files.length) {
    return false;
  }
  for (let index = 0; index < left.files.length; index += 1) {
    const a = left.files[index];
    const b = right.files[index];
    if (!a || !b) return false;
    if (a.path !== b.path || a.kind !== b.kind || a.depth !== b.depth) {
      return false;
    }
  }
  return true;
}

export function sameListings(
  current: DirectoryListing[],
  next: DirectoryListing[],
) {
  return (
    current.length === next.length &&
    current.every((entry, index) => {
      const other = next[index];
      return other ? sameListing(entry, other) : false;
    })
  );
}

export function useWorkspaceExplorerFiles(
  files: WorkspaceFile[],
  loadDirectory: ((path: string) => Promise<WorkspaceFile[]>) | undefined,
  onError: (path: string, error: unknown) => void,
  watchMode: "event" | "polling" = "polling",
) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [listings, setListings] = useState<DirectoryListing[]>([]);
  const roots = useMemo(
    () => files.filter((file) => file.isWorkspaceRoot).map((file) => file.path),
    [files],
  );
  const rootKey = roots.join("\n");
  const explorerFiles = useMemo(
    () => mergeExplorerDirectories(files, listings),
    [files, listings],
  );
  // Membership is asked once per directory per ancestor level, so a Set keeps
  // the walk linear instead of scanning the expanded list each time.
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const directoryKey = useMemo(
    () =>
      explorerFiles
        .filter((file) => {
          if (file.kind !== "directory" || !expandedSet.has(file.path)) {
            return false;
          }
          if (file.isWorkspaceRoot) return true;
          const root =
            file.workspacePath ??
            roots.find((path) => file.path.startsWith(`${path}/`));
          if (!root) return false;
          let parent = file.path.slice(0, file.path.lastIndexOf("/"));
          while (parent.length >= root.length) {
            if (!expandedSet.has(parent)) return false;
            parent = parent.slice(0, parent.lastIndexOf("/"));
          }
          return true;
        })
        .map((file) => file.path)
        .join("\n"),
    [expandedSet, explorerFiles, roots],
  );

  // The polling loop should survive a parent re-render: restarting it for a
  // new `files` array tore down the interval and re-listed every folder on
  // each tree refresh. Only the visible roots and open folders matter.
  const loadDirectoryRef = useRef(loadDirectory);
  loadDirectoryRef.current = loadDirectory;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const refreshRef = useRef<
    ((root: string, paths?: readonly string[]) => void) | undefined
  >();
  const refreshChangedDirectories = useCallback(
    (root: string, paths?: readonly string[]) => {
      refreshRef.current?.(root, paths);
    },
    [],
  );

  useEffect(() => {
    // With no expanded directories there is nothing to poll. In particular the
    // idle composer does not need an Explorer timer.
    if (!loadDirectoryRef.current || !directoryKey) return;
    let cancelled = false;
    let pending = false;
    const queued = new Set<string>();
    const failed = new Set<string>();
    const directories = directoryKey ? directoryKey.split("\n") : [];
    const refresh = async (paths: readonly string[] = directories) => {
      const load = loadDirectoryRef.current;
      if (
        cancelled ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        !load
      )
        return;
      for (const path of paths) queued.add(path);
      if (pending || queued.size === 0) return;
      const batch = [...queued];
      queued.clear();
      pending = true;
      const results = await Promise.allSettled(
        batch.map((path) => Promise.resolve().then(() => load(path))),
      );
      pending = false;
      if (cancelled) return;
      const updated: DirectoryListing[] = [];
      results.forEach((result, index) => {
        const path = batch[index];
        if (!path) return;
        if (result.status === "fulfilled") {
          failed.delete(path);
          updated.push({ path, files: result.value });
        } else if (!failed.has(path)) {
          failed.add(path);
          onErrorRef.current(path, result.reason);
        }
      });
      setListings((current) => {
        const currentRoots = rootsRef.current;
        const byPath = new Map(
          current
            .filter((entry) =>
              currentRoots.some(
                (root) =>
                  entry.path === root || entry.path.startsWith(`${root}/`),
              ),
            )
            .map((entry) => [entry.path, entry]),
        );
        for (const entry of updated) byPath.set(entry.path, entry);
        const next = [...byPath.values()];
        return sameListings(current, next) ? current : next;
      });
      if (queued.size) void refresh([]);
    };
    refreshRef.current = (root, paths) => {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      void refresh(
        directories.filter(
          (directory) =>
            (directory === root || directory.startsWith(prefix)) &&
            (!paths ||
              paths.some(
                (path) =>
                  path === directory ||
                  (path.endsWith("/")
                    ? directory.startsWith(path)
                    : directory.startsWith(`${path}/`)) ||
                  (path.slice(0, path.lastIndexOf("/")) || "/") === directory,
              )),
        ),
      );
    };
    void refresh();
    // Reconcile missed notifications and retain timely updates on polling-only roots.
    const refreshWhenVisible = () => void refresh();
    const timer = window.setInterval(
      refreshWhenVisible,
      watchMode === "event" ? 15_000 : 3_000,
    );
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      refreshRef.current = undefined;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [directoryKey, rootKey, watchMode]);
  return {
    explorerFiles,
    onExpandedDirectoriesChange: setExpanded,
    refreshChangedDirectories,
  };
}
