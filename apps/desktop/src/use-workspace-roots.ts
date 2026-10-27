import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  assessWorkspaceRoots,
  normalizedWorkspaceFolderPath,
  normalizedWorkspaceTrustPath,
  validateWorkspaceRoots,
  workspaceRootIssueMessage,
  workspaceRootIssueSummary,
  type GyroWorkspaceFile,
  type WorkbenchPreferences,
  type WorkspaceRootInspection,
  type WorkspaceRootIssue,
  type WorkspaceRootIssuesModel,
  type WorkspaceRootValidation,
} from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

/**
 * Filesystem facts for workspace roots, from `inspect_workspace_folders`.
 *
 * The browser preview has no filesystem. Its fixture paths all resolve as
 * themselves, except anything under `/preview/Missing`, which lets the
 * preview show the unavailable-folder row.
 */
export async function inspectWorkspaceFolders(
  paths: readonly string[],
): Promise<WorkspaceRootInspection[]> {
  if (paths.length === 0) return [];
  if (!isTauriRuntime()) {
    return paths.map((path) => ({
      path,
      canonicalPath: normalizedWorkspaceFolderPath(path),
      status: path.startsWith("/preview/Missing") ? "missing" : "ok",
    }));
  }
  return invoke<WorkspaceRootInspection[]>("inspect_workspace_folders", {
    paths: [...paths],
  });
}

/**
 * Inspect and validate candidates against a workspace in one round trip.
 *
 * `existing` is every configured root, primary first, including ones that
 * are unavailable right now: they still own a slot and still collide.
 */
export async function admitWorkspaceFolders(
  existing: readonly string[],
  candidates: readonly string[],
  allowNested = false,
): Promise<WorkspaceRootValidation> {
  const inspections = await inspectWorkspaceFolders([
    ...existing,
    ...candidates,
  ]);
  return validateWorkspaceRoots({
    existing: inspections.slice(0, existing.length),
    candidates: inspections.slice(existing.length),
    allowNested,
  });
}

/** Toast title and detail for rejected folders, or nothing when all passed. */
export function workspaceRootRejectionNotice(
  issues: readonly WorkspaceRootIssue[],
): [title: string, detail: string] | undefined {
  const detail = workspaceRootIssueSummary(issues);
  if (!detail) return undefined;
  const title =
    issues.length > 1
      ? `${issues.length} folders were not added`
      : issues[0]?.code === "duplicate"
        ? "Folder already added"
        : "Folder could not be added";
  return [title, detail];
}

/**
 * Validate a parsed workspace file the way an Explorer add would.
 *
 * The primary must exist: it names the project. Other folders that fail are
 * dropped from the result and reported, never trimmed silently. Folder paths
 * come back canonical so per-folder settings land on the stored key.
 */
export async function admitWorkspaceFile(
  parsed: GyroWorkspaceFile,
  allowNested = false,
) {
  const primary = parsed.folders[0]?.path;
  if (!primary)
    throw new Error("Workspace file does not contain a primary folder");
  const [primaryCheck] = await inspectWorkspaceFolders([primary]);
  if (primaryCheck?.status !== "ok") {
    const reason = workspaceRootIssueMessage(
      primaryCheck?.status ?? "invalid-path",
    );
    throw new Error(`${folderName(primary)}: ${reason}`);
  }
  const admission = await admitWorkspaceFolders(
    [primary],
    parsed.folders.slice(1).map((folder) => folder.path),
    allowNested,
  );
  const workspaceFile: GyroWorkspaceFile = {
    ...parsed,
    folders: parsed.folders.flatMap((folder, index) => {
      const path =
        index === 0
          ? primary
          : admission.canonicalByPath[
              normalizedWorkspaceFolderPath(folder.path)
            ];
      return path ? [{ ...folder, path }] : [];
    }),
  };
  return {
    workspaceFile,
    extraFolders: admission.accepted,
    rejection: workspaceRootRejectionNotice(admission.issues),
  };
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

type CanonicalizeAction = {
  type: "canonicalize-workspace-folders";
  workspacePath: string;
  replacements: Record<string, string>;
};

/**
 * Keep configured roots honest while a workspace is open.
 *
 * Roots are re-inspected when the set changes, when the window regains
 * focus (a drive may have been plugged back in), and on `retry`. Unavailable
 * extra roots leave `roots` but stay in preferences, so they return on their
 * own once the folder is back. Diagnostics are never persisted.
 */
export function useWorkspaceRootHealth(
  configured: readonly string[],
  workspacePath: string | undefined,
  dispatch: (action: CanonicalizeAction) => void,
) {
  const key = configured.join("\n");
  const [snapshot, setSnapshot] = useState<{
    key: string;
    inspections: WorkspaceRootInspection[];
  }>();
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const onFocus = () => setRevision((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (configured.length === 0) return;
    let cancelled = false;
    void inspectWorkspaceFolders(configured)
      .then((inspections) => {
        if (!cancelled) setSnapshot({ key, inspections });
      })
      .catch(() => {
        // An inspection failure must not hide roots; keep the last snapshot.
      });
    return () => {
      cancelled = true;
    };
    // `key` is the content of `configured`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);

  const health = useMemo(
    () =>
      assessWorkspaceRoots(
        configured,
        snapshot?.key === key ? snapshot.inspections : [],
        workspacePath,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, snapshot, workspacePath],
  );

  const stableRoots = useRef<string[]>([]);
  const liveKey = health.live.join("\n");
  const roots = useMemo(() => {
    if (stableRoots.current.join("\n") !== liveKey) {
      stableRoots.current = health.live;
    }
    return stableRoots.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  const replacementKey = JSON.stringify(health.canonicalReplacements);
  useEffect(() => {
    if (!workspacePath || replacementKey === "{}") return;
    dispatch({
      type: "canonicalize-workspace-folders",
      workspacePath,
      replacements: health.canonicalReplacements,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replacementKey, workspacePath]);

  return { roots, issues: health.issues, retry };
}

type RecoveryAction =
  | {
      type: "relocate-workspace-folder";
      workspacePath: string;
      from: string;
      to: string;
    }
  | {
      type: "set-workspace-trust";
      path: string;
      decision: "trusted" | "restricted";
    };

/**
 * Explorer actions for roots the health check set aside.
 *
 * Locate… re-points a moved folder (the primary re-keys the whole project and
 * reopens it there); Remove drops an extra root; Check again re-inspects.
 * A located folder is a new location, so it starts restricted like any add.
 */
export function useWorkspaceRootRecovery({
  activateWorkspacePath,
  configured,
  dispatch,
  health,
  notify,
  pickFolder,
  preferences,
  removeFolder,
  workspacePath,
}: {
  activateWorkspacePath: (path: string, title?: string) => Promise<unknown>;
  configured: readonly string[];
  dispatch: (action: RecoveryAction) => void;
  health: { issues: WorkspaceRootIssue[]; retry: () => void };
  notify: (
    kind: "command-failed" | "terminal",
    title: string,
    detail: string,
  ) => void;
  pickFolder: (title: string) => Promise<string | null>;
  preferences: Pick<WorkbenchPreferences, "projectDetails" | "workspaceTrust">;
  removeFolder: (path: string) => void;
  workspacePath: string | undefined;
}): WorkspaceRootIssuesModel {
  // Callers pass fresh closures each render; read them at click time instead
  // of rebuilding the model the Explorer renders from.
  const latest = useRef({
    activateWorkspacePath,
    configured,
    pickFolder,
    preferences,
  });
  latest.current = {
    activateWorkspacePath,
    configured,
    pickFolder,
    preferences,
  };

  const locate = useCallback(
    async (from: string) => {
      if (!workspacePath) return;
      const chosen = await latest.current.pickFolder(
        `Locate ${folderName(from)}`,
      );
      if (!chosen) return;
      const current = latest.current;
      const admission = await admitWorkspaceFolders(
        current.configured.filter((root) => root !== from),
        [chosen],
        current.preferences.projectDetails?.[workspacePath]?.allowNestedFolders,
      ).catch((error: unknown) => {
        notify("command-failed", "Folder could not be located", String(error));
        return undefined;
      });
      const to = admission?.accepted[0];
      if (!admission || !to) {
        const rejection =
          admission && workspaceRootRejectionNotice(admission.issues);
        if (rejection) notify("command-failed", ...rejection);
        return;
      }
      dispatch({ type: "relocate-workspace-folder", workspacePath, from, to });
      if (
        !(
          normalizedWorkspaceTrustPath(to) in current.preferences.workspaceTrust
        )
      ) {
        dispatch({
          type: "set-workspace-trust",
          path: to,
          decision: "restricted",
        });
      }
      if (from === workspacePath) {
        await current.activateWorkspacePath(to, "Workspace folder relocated");
      } else {
        notify("terminal", "Workspace folder relocated", folderName(to));
      }
    },
    [dispatch, notify, workspacePath],
  );

  return useMemo(
    () => ({
      issues: health.issues,
      primaryPath: workspacePath,
      onLocate: (path: string) => void locate(path),
      onRemove: removeFolder,
      onRetry: health.retry,
    }),
    [health.issues, health.retry, locate, removeFolder, workspacePath],
  );
}
