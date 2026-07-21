import type { WorkspaceFile, WorkspaceScopedSettings } from "./types";

export const MAX_WORKSPACE_FOLDERS = 20;

export type GyroWorkspaceFile = {
  version: 1;
  folders: Array<{
    path: string;
    name?: string;
    settings?: WorkspaceScopedSettings;
  }>;
  settings?: WorkspaceScopedSettings;
};

function parsedWorkspaceSettings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const patterns = (candidate: unknown) =>
    Array.isArray(candidate)
      ? candidate
          .filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
          .map((item) => item.trim())
          .slice(0, 100)
      : undefined;
  const settings: WorkspaceScopedSettings = {
    filesExclude: patterns(record.filesExclude),
    searchExclude: patterns(record.searchExclude),
    searchMaxResults:
      typeof record.searchMaxResults === "number" &&
      Number.isFinite(record.searchMaxResults)
        ? Math.min(1_000, Math.max(10, Math.round(record.searchMaxResults)))
        : undefined,
    editorMinimapEnabled:
      typeof record.editorMinimapEnabled === "boolean"
        ? record.editorMinimapEnabled
        : undefined,
  };
  const normalized = Object.fromEntries(
    Object.entries(settings).filter(([, setting]) => setting !== undefined),
  ) as WorkspaceScopedSettings;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizedWorkspaceFolderPath(path: string) {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function workspaceFolderPaths(
  primaryPath: string | undefined,
  foldersByWorkspace: Readonly<Record<string, readonly string[]>> | undefined,
) {
  if (!primaryPath) return [];
  const primary = normalizedWorkspaceFolderPath(primaryPath);
  const configured = foldersByWorkspace?.[primary] ?? [];
  return [primary, ...configured]
    .map(normalizedWorkspaceFolderPath)
    .filter(
      (path, index, paths) => Boolean(path) && paths.indexOf(path) === index,
    )
    .slice(0, MAX_WORKSPACE_FOLDERS);
}

export function workspaceRootForPath(
  roots: readonly string[],
  path: string | undefined,
) {
  if (!path) return roots[0];
  const normalizedPath = normalizedWorkspaceFolderPath(path);
  return [...roots]
    .map(normalizedWorkspaceFolderPath)
    .sort((first, second) => second.length - first.length)
    .find(
      (root) =>
        normalizedPath === root || normalizedPath.startsWith(`${root}/`),
    );
}

export function absoluteWorkspaceFilePath(root: string, path: string) {
  const normalizedRoot = normalizedWorkspaceFolderPath(root);
  const normalizedPath = path.replaceAll("\\", "/");
  if (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  ) {
    return normalizedPath;
  }
  return `${normalizedRoot}/${normalizedPath.replace(/^\/+/, "")}`;
}

export function workspaceFilesForRoot(
  root: string,
  files: readonly WorkspaceFile[],
) {
  const normalizedRoot = normalizedWorkspaceFolderPath(root);
  return [
    {
      path: normalizedRoot,
      kind: "directory" as const,
      depth: 0,
      workspacePath: normalizedRoot,
      relativePath: "",
      isWorkspaceRoot: true,
    },
    ...files
      .filter((file) => !file.isWorkspaceRoot)
      .map((file) => ({
        ...file,
        path: absoluteWorkspaceFilePath(
          normalizedRoot,
          file.relativePath ?? file.path,
        ),
        depth: Math.max(1, (file.depth ?? 1) + 1),
        workspacePath: normalizedRoot,
        relativePath: file.relativePath ?? file.path,
        isWorkspaceRoot: false,
      })),
  ];
}

export function mergeWorkspaceRootFiles(
  current: readonly WorkspaceFile[],
  roots: readonly string[],
  root: string,
  files: readonly WorkspaceFile[],
) {
  const normalizedRoots = roots.map(normalizedWorkspaceFolderPath);
  const normalizedRoot = normalizedWorkspaceFolderPath(root);
  const retained = current.filter(
    (file) =>
      file.workspacePath &&
      normalizedWorkspaceFolderPath(file.workspacePath) !== normalizedRoot &&
      normalizedRoots.includes(
        normalizedWorkspaceFolderPath(file.workspacePath),
      ),
  );
  const byRoot = new Map<string, WorkspaceFile[]>();
  for (const file of [...retained, ...workspaceFilesForRoot(root, files)]) {
    const fileRoot = normalizedWorkspaceFolderPath(
      file.workspacePath ?? normalizedRoot,
    );
    const entries = byRoot.get(fileRoot) ?? [];
    entries.push(file);
    byRoot.set(fileRoot, entries);
  }
  return normalizedRoots.flatMap(
    (workspaceRoot) => byRoot.get(workspaceRoot) ?? [],
  );
}

function parentWorkspacePath(path: string) {
  const normalized = normalizedWorkspaceFolderPath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "/";
}

function resolvedWorkspaceFolderPath(basePath: string, path: string) {
  if (/^(?:[a-z]:)?\//i.test(path.replaceAll("\\", "/"))) {
    return normalizedWorkspaceFolderPath(path);
  }
  const segments = `${basePath}/${path}`.replaceAll("\\", "/").split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `${basePath.startsWith("/") ? "/" : ""}${resolved.join("/")}`;
}

export function parseGyroWorkspaceFile(content: string, filePath: string) {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workspace file must contain a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.folders)) {
    throw new Error("Workspace file must use version 1 and include folders");
  }
  const basePath = parentWorkspacePath(filePath);
  const folders = record.folders
    .flatMap((folder) => {
      if (!folder || typeof folder !== "object" || Array.isArray(folder)) {
        return [];
      }
      const entry = folder as Record<string, unknown>;
      if (typeof entry.path !== "string" || !entry.path.trim()) return [];
      return [
        {
          path: resolvedWorkspaceFolderPath(basePath, entry.path.trim()),
          name:
            typeof entry.name === "string" && entry.name.trim()
              ? entry.name.trim()
              : undefined,
          settings: parsedWorkspaceSettings(entry.settings),
        },
      ];
    })
    .filter(
      (folder, index, all) =>
        all.findIndex((candidate) => candidate.path === folder.path) === index,
    )
    .slice(0, MAX_WORKSPACE_FOLDERS);
  if (folders.length === 0) {
    throw new Error("Workspace file does not contain any valid folders");
  }
  return {
    version: 1,
    folders,
    settings: parsedWorkspaceSettings(record.settings),
  } satisfies GyroWorkspaceFile;
}

function relativeWorkspacePath(fromDirectory: string, targetPath: string) {
  const from = normalizedWorkspaceFolderPath(fromDirectory)
    .split("/")
    .filter(Boolean);
  const target = normalizedWorkspaceFolderPath(targetPath)
    .split("/")
    .filter(Boolean);
  if (/^[a-z]:$/i.test(from[0] ?? "") && from[0] !== target[0]) {
    return normalizedWorkspaceFolderPath(targetPath);
  }
  let common = 0;
  while (from[common] === target[common] && common < from.length) common += 1;
  const relative = [
    ...Array.from({ length: from.length - common }, () => ".."),
    ...target.slice(common),
  ].join("/");
  return relative.startsWith(".") ? relative : `./${relative || "."}`;
}

export function serializeGyroWorkspaceFile(
  roots: readonly string[],
  filePath: string,
  options?: {
    workspaceSettings?: WorkspaceScopedSettings;
    folderSettingsByPath?: Readonly<Record<string, WorkspaceScopedSettings>>;
  },
) {
  const basePath = parentWorkspacePath(filePath);
  const workspaceFile: GyroWorkspaceFile = {
    version: 1,
    folders: roots.slice(0, MAX_WORKSPACE_FOLDERS).map((root) => {
      const settings = parsedWorkspaceSettings(
        options?.folderSettingsByPath?.[normalizedWorkspaceFolderPath(root)],
      );
      return {
        path: relativeWorkspacePath(basePath, root),
        ...(settings ? { settings } : {}),
      };
    }),
    settings: parsedWorkspaceSettings(options?.workspaceSettings),
  };
  return `${JSON.stringify(workspaceFile, null, 2)}\n`;
}
