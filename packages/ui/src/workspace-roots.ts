import type { WorkbenchPreferences } from "./types.ts";
import {
  MAX_WORKSPACE_FOLDERS,
  normalizedWorkspaceFolderList,
  normalizedWorkspaceFolderPath,
} from "./workspace-project.ts";

/**
 * Workspace root contract.
 *
 * The desktop shell answers what a path *is* (`inspect_workspace_folders`,
 * backed by `gyro_core::workspace_roots`). This module decides whether it may
 * join a workspace. Every entry point that adds roots — the Explorer button,
 * a folder drop, project settings, and workspace-file import — goes through
 * {@link validateWorkspaceRoots}, so a rejection always has a code and a
 * message instead of a silent drop.
 */

/** Mirrors `WorkspaceRootStatus` in `crates/gyro-core/src/workspace_roots.rs`. */
export type WorkspaceRootStatus =
  "ok" | "invalid-path" | "missing" | "not-directory" | "unreadable";

export type WorkspaceRootInspection = {
  path: string;
  canonicalPath?: string;
  status: WorkspaceRootStatus;
  detail?: string;
};

export type WorkspaceRootIssueCode =
  Exclude<WorkspaceRootStatus, "ok"> | "duplicate" | "overlap" | "cap-exceeded";

export type WorkspaceRootIssue = {
  path: string;
  code: WorkspaceRootIssueCode;
  message: string;
  /** The existing root a duplicate or overlap collided with. */
  relatedPath?: string;
};

export type WorkspaceRootValidation = {
  /** Canonical paths, in request order, safe to persist. */
  accepted: string[];
  /** Requested (normalized) path → the canonical path it was accepted as. */
  canonicalByPath: Record<string, string>;
  issues: WorkspaceRootIssue[];
};

/** Whether a missing or unreadable root can come back without user action. */
export function workspaceRootIssueIsTransient(code: WorkspaceRootIssueCode) {
  return code === "missing" || code === "unreadable";
}

export function workspaceRootIdentity(inspection: WorkspaceRootInspection) {
  return normalizedWorkspaceFolderPath(
    inspection.canonicalPath ?? inspection.path,
  );
}

function folderLabel(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function containsPath(parent: string, child: string) {
  if (parent === child) return true;
  return child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

export function workspaceRootIssueMessage(
  code: WorkspaceRootIssueCode,
  options: { relatedPath?: string; nested?: "inside" | "contains" } = {},
) {
  const related = options.relatedPath
    ? folderLabel(options.relatedPath)
    : undefined;
  switch (code) {
    case "invalid-path":
      return "Not a usable folder path";
    case "missing":
      return "Folder not found";
    case "not-directory":
      return "Not a folder";
    case "unreadable":
      return "Gyro can't read this folder";
    case "duplicate":
      return related
        ? `Already in this workspace as ${related}`
        : "Already in this workspace";
    case "overlap":
      return options.nested === "contains"
        ? `Contains ${related ?? "a folder"}, which is already in this workspace`
        : `Inside ${related ?? "a folder"}, which is already in this workspace`;
    case "cap-exceeded":
      return `A workspace holds up to ${MAX_WORKSPACE_FOLDERS} folders`;
  }
}

function issue(
  path: string,
  code: WorkspaceRootIssueCode,
  options: { relatedPath?: string; nested?: "inside" | "contains" } = {},
): WorkspaceRootIssue {
  return {
    path,
    code,
    message: workspaceRootIssueMessage(code, {
      ...options,
      // "Already in this workspace as shared" says nothing for a folder that
      // is itself named shared; the path differs, so say that instead.
      relatedPath:
        options.relatedPath &&
        folderLabel(options.relatedPath) === folderLabel(path) &&
        code === "duplicate"
          ? undefined
          : options.relatedPath,
    }),
    ...(options.relatedPath ? { relatedPath: options.relatedPath } : {}),
  };
}

/**
 * Decide which candidate roots may join a workspace.
 *
 * `existing` is the workspace as it stands, primary first. Its entries count
 * toward the cap and collide with candidates even when they are currently
 * unavailable: a folder on an unplugged drive still owns its slot. Nesting is
 * refused unless the project opted in, because a nested root lists, searches,
 * and watches the same files twice.
 */
export function validateWorkspaceRoots({
  existing,
  candidates,
  allowNested = false,
  maxRoots = MAX_WORKSPACE_FOLDERS,
}: {
  existing: readonly WorkspaceRootInspection[];
  candidates: readonly WorkspaceRootInspection[];
  allowNested?: boolean;
  maxRoots?: number;
}): WorkspaceRootValidation {
  const kept = existing.map((root) => ({
    path: normalizedWorkspaceFolderPath(root.path),
    identity: workspaceRootIdentity(root),
  }));
  const accepted: string[] = [];
  const canonicalByPath: Record<string, string> = {};
  const issues: WorkspaceRootIssue[] = [];
  for (const candidate of candidates) {
    const path = normalizedWorkspaceFolderPath(candidate.path);
    if (candidate.status !== "ok") {
      issues.push(issue(path, candidate.status));
      continue;
    }
    const identity = workspaceRootIdentity(candidate);
    const duplicate = kept.find(
      (root) => root.identity === identity || root.path === path,
    );
    if (duplicate) {
      issues.push(
        issue(path, "duplicate", {
          relatedPath: duplicate.path === path ? undefined : duplicate.path,
        }),
      );
      continue;
    }
    if (!allowNested) {
      const outer = kept.find((root) => containsPath(root.identity, identity));
      const inner = outer
        ? undefined
        : kept.find((root) => containsPath(identity, root.identity));
      const related = outer ?? inner;
      if (related) {
        issues.push(
          issue(path, "overlap", {
            relatedPath: related.path,
            nested: outer ? "inside" : "contains",
          }),
        );
        continue;
      }
    }
    if (kept.length >= maxRoots) {
      issues.push(issue(path, "cap-exceeded"));
      continue;
    }
    kept.push({ path: identity, identity });
    accepted.push(identity);
    canonicalByPath[path] = identity;
  }
  return { accepted, canonicalByPath, issues };
}

/** One toast line for a batch of rejections. */
export function workspaceRootIssueSummary(
  issues: readonly WorkspaceRootIssue[],
) {
  if (issues.length === 0) return undefined;
  const lines = issues
    .slice(0, 3)
    .map((item) => `${folderLabel(item.path)}: ${item.message}`);
  if (issues.length > 3) lines.push(`${issues.length - 3} more`);
  return lines.join(" · ");
}

export type WorkspaceRootHealth = {
  /** Roots the session, Explorer, and agent may use right now. */
  live: string[];
  /** Why each configured root outside `live` was set aside. */
  issues: WorkspaceRootIssue[];
  /**
   * Extra roots stored under a non-canonical spelling (`/tmp/x` for
   * `/private/tmp/x`, a symlink, a trailing alias). Persist the canonical
   * form so duplicates collapse and backend identity stays stable.
   */
  canonicalReplacements: Record<string, string>;
};

/**
 * Split configured roots into usable ones and diagnostics.
 *
 * The project's primary folder always stays in `live`, even when missing:
 * sessions and preferences are keyed by it, and dropping it would silently
 * promote another folder. It is still reported so the Explorer can offer
 * Locate…. A preferred primary may lead `configured`, so pass the real one.
 */
export function assessWorkspaceRoots(
  configured: readonly string[],
  inspections: readonly WorkspaceRootInspection[],
  primaryPath: string | undefined = configured[0],
): WorkspaceRootHealth {
  const primary =
    primaryPath === undefined
      ? undefined
      : normalizedWorkspaceFolderPath(primaryPath);
  const byPath = new Map(
    inspections.map((inspection) => [
      normalizedWorkspaceFolderPath(inspection.path),
      inspection,
    ]),
  );
  const live: string[] = [];
  const identities = new Map<string, string>();
  const issues: WorkspaceRootIssue[] = [];
  const canonicalReplacements: Record<string, string> = {};
  configured.forEach((rawPath) => {
    const path = normalizedWorkspaceFolderPath(rawPath);
    const isPrimary = path === primary;
    const inspection = byPath.get(path);
    if (!inspection) {
      live.push(path);
      return;
    }
    if (inspection.status !== "ok") {
      issues.push(issue(path, inspection.status));
      if (isPrimary) live.push(path);
      return;
    }
    const identity = workspaceRootIdentity(inspection);
    const earlier = identities.get(identity);
    if (earlier !== undefined && !isPrimary) {
      issues.push(issue(path, "duplicate", { relatedPath: earlier }));
      return;
    }
    identities.set(identity, path);
    if (!isPrimary && identity !== path) canonicalReplacements[path] = identity;
    live.push(path);
  });
  return { live, issues, canonicalReplacements };
}

type FolderPreferences = Pick<
  WorkbenchPreferences,
  | "workspaceFolders"
  | "projectDetails"
  | "workspaceSettingsByWorkspace"
  | "workspaceSettingsByFolder"
>;

function renamedKey<T>(
  record: Readonly<Record<string, T>> | undefined,
  from: string,
  to: string,
) {
  if (!record || !(from in record)) return record;
  const { [from]: value, ...rest } = record;
  return { ...rest, [to]: value as T };
}

/**
 * Point a workspace at a folder that moved.
 *
 * An extra root is swapped in place. The primary keys every per-project
 * preference, so moving it re-keys folders, details, and settings together
 * instead of orphaning them under the old path. Trust is deliberately not
 * carried over: the caller decides how the new location starts.
 */
export function relocateWorkspaceFolderPreferences<T extends FolderPreferences>(
  preferences: T,
  workspacePath: string,
  fromPath: string,
  toPath: string,
): T {
  const workspace = normalizedWorkspaceFolderPath(workspacePath);
  const from = normalizedWorkspaceFolderPath(fromPath);
  const to = normalizedWorkspaceFolderPath(toPath);
  if (from === to) return preferences;
  const folderSettings = renamedKey(
    preferences.workspaceSettingsByFolder,
    from,
    to,
  );
  if (from !== workspace) {
    const current = preferences.workspaceFolders[workspace] ?? [];
    return {
      ...preferences,
      workspaceFolders: {
        ...preferences.workspaceFolders,
        [workspace]: normalizedWorkspaceFolderList(
          workspace,
          current.map((folder) =>
            normalizedWorkspaceFolderPath(folder) === from ? to : folder,
          ),
        ),
      },
      workspaceSettingsByFolder: folderSettings ?? {},
    };
  }
  const folders = renamedKey(preferences.workspaceFolders, from, to) ?? {};
  const details = renamedKey(preferences.projectDetails, from, to);
  const detail = details?.[to];
  return {
    ...preferences,
    workspaceFolders: {
      ...folders,
      [to]: normalizedWorkspaceFolderList(to, folders[to] ?? []),
    },
    projectDetails:
      details && detail
        ? {
            ...details,
            [to]: {
              ...detail,
              primaryFolder:
                detail.primaryFolder &&
                normalizedWorkspaceFolderPath(detail.primaryFolder) === from
                  ? to
                  : detail.primaryFolder,
            },
          }
        : details,
    workspaceSettingsByWorkspace:
      renamedKey(preferences.workspaceSettingsByWorkspace, from, to) ?? {},
    workspaceSettingsByFolder: folderSettings ?? {},
  };
}
