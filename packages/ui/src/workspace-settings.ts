import type { WorkspaceScopedSettings } from "./types";
import { normalizedWorkspaceFolderPath } from "./workspace-project.ts";

export const defaultWorkspaceUserSettings: Required<WorkspaceScopedSettings> = {
  filesExclude: [".git/**"],
  searchExclude: [
    ".git/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "target/**",
  ],
  searchMaxResults: 200,
  editorMinimapEnabled: true,
};

export function normalizedWorkspaceUserSettings(
  value: WorkspaceScopedSettings | undefined,
) {
  const settings = normalizedWorkspaceScopedSettings(value);
  const legacy = [
    ".git/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "target/**",
  ];
  // Previous releases persisted these defaults as user settings. Upgrade only
  // that exact set; custom exclusions and per-folder settings remain intentional.
  if (
    settings.filesExclude?.length === legacy.length &&
    legacy.every((pattern) => settings.filesExclude?.includes(pattern))
  )
    settings.filesExclude = [...defaultWorkspaceUserSettings.filesExclude];
  return settings;
}

function normalizedPatterns(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (pattern): pattern is string =>
        typeof pattern === "string" && pattern.trim().length > 0,
    )
    .map((pattern) => pattern.trim())
    .filter((pattern, index, patterns) => patterns.indexOf(pattern) === index)
    .slice(0, 100);
}

export function normalizedWorkspaceScopedSettings(
  value: Partial<WorkspaceScopedSettings> | undefined,
): WorkspaceScopedSettings {
  if (!value || typeof value !== "object") return {};
  const filesExclude = normalizedPatterns(value.filesExclude);
  const searchExclude = normalizedPatterns(value.searchExclude);
  const searchMaxResults =
    typeof value.searchMaxResults === "number" &&
    Number.isFinite(value.searchMaxResults)
      ? Math.min(1_000, Math.max(10, Math.round(value.searchMaxResults)))
      : undefined;
  const editorMinimapEnabled =
    typeof value.editorMinimapEnabled === "boolean"
      ? value.editorMinimapEnabled
      : undefined;
  return {
    ...(filesExclude ? { filesExclude } : {}),
    ...(searchExclude ? { searchExclude } : {}),
    ...(searchMaxResults !== undefined ? { searchMaxResults } : {}),
    ...(editorMinimapEnabled !== undefined ? { editorMinimapEnabled } : {}),
  };
}

export function resolvedWorkspaceSettings(
  userSettings: WorkspaceScopedSettings | undefined,
  workspaceSettingsByWorkspace:
    Readonly<Record<string, WorkspaceScopedSettings>> | undefined,
  folderSettingsByFolder:
    Readonly<Record<string, WorkspaceScopedSettings>> | undefined,
  workspacePath?: string,
  folderPath?: string,
): Required<WorkspaceScopedSettings> {
  const workspaceKey = workspacePath
    ? normalizedWorkspaceFolderPath(workspacePath)
    : undefined;
  const folderKey = folderPath
    ? normalizedWorkspaceFolderPath(folderPath)
    : undefined;
  return {
    ...defaultWorkspaceUserSettings,
    ...normalizedWorkspaceScopedSettings(userSettings),
    ...(workspaceKey
      ? normalizedWorkspaceScopedSettings(
          workspaceSettingsByWorkspace?.[workspaceKey],
        )
      : {}),
    ...(folderKey
      ? normalizedWorkspaceScopedSettings(folderSettingsByFolder?.[folderKey])
      : {}),
  };
}

function globPatternRegex(pattern: string) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`^(?:${source})$`);
}

export function workspacePathMatchesGlob(path: string, pattern: string) {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^!/, "");
  if (!normalizedPattern) return false;
  const regex = globPatternRegex(normalizedPattern);
  return (
    regex.test(normalizedPath) ||
    (normalizedPattern.endsWith("/**") &&
      normalizedPath === normalizedPattern.slice(0, -3)) ||
    (!normalizedPattern.includes("/") &&
      normalizedPath.split("/").some((segment) => regex.test(segment)))
  );
}

export function workspacePathExcluded(
  path: string,
  patterns: readonly string[] | undefined,
) {
  return (patterns ?? []).some((pattern) =>
    workspacePathMatchesGlob(path, pattern),
  );
}
