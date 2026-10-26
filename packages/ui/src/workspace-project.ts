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
  preferredPrimary?: string,
) {
  if (!primaryPath) return [];
  const primary = normalizedWorkspaceFolderPath(primaryPath);
  const configured = foldersByWorkspace?.[primary] ?? [];
  const roots = [primary, ...configured]
    .map(normalizedWorkspaceFolderPath)
    .filter(
      (path, index, paths) => Boolean(path) && paths.indexOf(path) === index,
    )
    .slice(0, MAX_WORKSPACE_FOLDERS);
  const preferred = preferredPrimary
    ? normalizedWorkspaceFolderPath(preferredPrimary)
    : undefined;
  return preferred && roots.includes(preferred)
    ? [preferred, ...roots.filter((root) => root !== preferred)]
    : roots;
}

export type WorkspaceMovePlan =
  | { kind: "move"; root: string; fromPath: string; toPath: string }
  | { kind: "noop" }
  | { kind: "blocked"; reason: string };

/**
 * Where an Explorer drag or Move… should land.
 *
 * Same-folder drops and moves into a folder's own contents do nothing.
 * A destination in another workspace root is refused. `..` is collapsed
 * before that check, so a typed path cannot look local and then leave the
 * root. The caller still has to confirm when the destination name already exists.
 */
export function planWorkspaceMove(
  roots: readonly string[],
  fromPath: string,
  destinationDirectory: string,
): WorkspaceMovePlan {
  const source = trimPath(fromPath);
  if (!source) return { kind: "noop" };
  const root = workspaceRootForPath(roots, source);
  if (!root) {
    return {
      kind: "blocked",
      reason: "Move stays inside this workspace folder",
    };
  }
  const requested = trimPath(destinationDirectory);
  const destination = !requested
    ? root
    : collapseWorkspacePath(
        requested.startsWith("/") || /^[a-z]:\//i.test(requested)
          ? requested
          : `${root}/${requested.replace(/^\/+/, "")}`,
      );
  if (!destination || destination.split("/").includes("..")) {
    return {
      kind: "blocked",
      reason: "Move stays inside this workspace folder",
    };
  }
  const destinationRoot = workspaceRootForPath(roots, destination);
  if (!destinationRoot || destinationRoot !== root) {
    return {
      kind: "blocked",
      reason: "Move stays inside this workspace folder",
    };
  }
  if (destination === source || destination.startsWith(`${source}/`)) {
    return { kind: "noop" };
  }
  const name = source.slice(source.lastIndexOf("/") + 1);
  if (!name) return { kind: "noop" };
  const toPath = `${destination}/${name}`;
  if (toPath === source) return { kind: "noop" };
  return { kind: "move", root, fromPath: source, toPath };
}

function trimPath(path: string) {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

/** Resolve `.` and `..` without leaving a typed destination as a string prefix. */
function collapseWorkspacePath(path: string) {
  const normalized = trimPath(path);
  if (!normalized) return "";
  const drive = normalized.match(/^[a-z]:/i)?.[0];
  const absolute = /^(?:[a-z]:)?\//i.test(normalized);
  const resolved: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (drive && segment.toLowerCase() === drive.toLowerCase()) {
      resolved.push(drive);
      continue;
    }
    if (segment === "..") {
      const top = resolved[resolved.length - 1];
      if (top && top.toLowerCase() !== drive?.toLowerCase()) resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  const joined = resolved.join("/");
  if (absolute && !drive) return joined ? `/${joined}` : "/";
  return joined;
}

/** How many names Ask Gyro includes before it says the rest were left out. */
export const EXPLORER_ASK_LISTING_LIMIT = 80;

/**
 * A short folder listing for the composer.
 *
 * One or two levels, names only. The caller passes a bounded `list_workspace_tree`
 * result so this never walks the disk itself.
 */
export function formatExplorerAskListing(
  folderName: string,
  entries: readonly { path: string; kind: string }[],
  limit = EXPLORER_ASK_LISTING_LIMIT,
): string {
  const name = folderName.trim() || "folder";
  const lines = [`${name}/`];
  const visible = entries.slice(0, Math.max(0, limit));
  for (const entry of visible) {
    const parts = entry.path.replaceAll("\\", "/").split("/").filter(Boolean);
    const depth = Math.max(1, parts.length);
    const label = parts.at(-1) ?? entry.path;
    lines.push(
      `${"  ".repeat(depth)}${label}${entry.kind === "directory" ? "/" : ""}`,
    );
  }
  if (entries.length > visible.length) {
    lines.push(`  … ${entries.length - visible.length} more`);
  }
  return lines.join("\n");
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

/**
 * Path the review tree and editor chrome should show.
 *
 * Agent events often carry an absolute workspace file. Splitting that on `/`
 * turns `/Users/…/Gyro/README.md` into four nested folders whose names collapse
 * to "U.." in the changed-files column. Strip the owning root so the tree
 * starts at the project, the way Explorer already does.
 */
export function workspaceRelativeFilePath(
  path: string,
  workspacePath?: string,
) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || !workspacePath) {
    return normalized;
  }
  const root = normalizedWorkspaceFolderPath(workspacePath);
  const file = normalizedWorkspaceFolderPath(normalized);
  if (file === root) {
    return file.split("/").filter(Boolean).at(-1) ?? file;
  }
  if (file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return normalized;
}

const GENERATED_EXPLORER_ENTRY_NAMES = new Set([
  ".DS_Store",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

/** Keep project content ahead of root-level setup and generated folders. */
export function workspaceExplorerRootEntryGroup(name: string) {
  if (GENERATED_EXPLORER_ENTRY_NAMES.has(name)) return "generated" as const;
  return name.startsWith(".")
    ? ("configuration" as const)
    : ("project" as const);
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

/** Absolute path for Copy Path and Reveal. Explorer rows already store it on `path`. */
export function workspaceCopyAbsolutePath(file: Pick<WorkspaceFile, "path">) {
  return file.path;
}

/**
 * Path relative to the workspace root.
 *
 * `path` on an explorer row is absolute, so copying that string makes
 * "Copy Relative Path" identical to an absolute copy. Prefer the stored
 * relative path, then strip the root.
 */
export function workspaceCopyRelativePath(
  file: Pick<WorkspaceFile, "path" | "workspacePath" | "relativePath">,
) {
  const stored = file.relativePath
    ?.replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (stored) return stored;
  return workspaceRelativeFilePath(file.path, file.workspacePath);
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
