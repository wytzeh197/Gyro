import { AlertTriangle, FolderSearch, RefreshCw, X } from "lucide-react";
import type { WorkspaceRootIssue } from "./workspace-roots";
import { workspaceRootIssueIsTransient } from "./workspace-roots";
import "./workspace-root-issues.css";

export type WorkspaceRootIssuesModel = {
  issues: readonly WorkspaceRootIssue[];
  /** The project's primary folder. It can be located but never removed. */
  primaryPath?: string;
  onLocate: (path: string) => void;
  onRemove: (path: string) => void;
  onRetry: () => void;
};

/**
 * Configured roots Gyro set aside: missing, unreadable, or duplicated.
 *
 * The folders stay in the project, so an unplugged drive comes back on its
 * own. Each row says why and offers the fix that applies: Locate… for a
 * folder that moved, Remove for one that is gone for good.
 */
export function WorkspaceRootIssues({
  model,
}: {
  model?: WorkspaceRootIssuesModel;
}) {
  if (!model || model.issues.length === 0) return null;
  const hasTransient = model.issues.some((issue) =>
    workspaceRootIssueIsTransient(issue.code),
  );
  return (
    <div
      aria-label="Unavailable workspace folders"
      className="gyro-root-issues"
      role="group"
    >
      {model.issues.map((issue) => {
        const name = issue.path.split("/").filter(Boolean).at(-1) ?? issue.path;
        const isPrimary = issue.path === model.primaryPath;
        return (
          <div
            className="gyro-root-issue"
            data-code={issue.code}
            key={`${issue.code}:${issue.path}`}
            title={issue.path}
          >
            <AlertTriangle
              aria-hidden
              className="gyro-root-issue-icon"
              size={13}
            />
            <span className="gyro-root-issue-text">
              <strong>{name}</strong>
              <span>
                {isPrimary
                  ? `Primary folder · ${issue.message}`
                  : issue.message}
              </span>
            </span>
            {issue.code !== "duplicate" ? (
              <button
                aria-label={`Locate ${name}`}
                onClick={() => model.onLocate(issue.path)}
                title="Locate folder…"
                type="button"
              >
                <FolderSearch size={13} />
              </button>
            ) : null}
            {isPrimary ? null : (
              <button
                aria-label={`Remove ${name} from workspace`}
                onClick={() => model.onRemove(issue.path)}
                title="Remove from workspace"
                type="button"
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
      {hasTransient ? (
        <button
          className="gyro-root-issues-retry"
          onClick={model.onRetry}
          type="button"
        >
          <RefreshCw size={12} />
          Check again
        </button>
      ) : null}
    </div>
  );
}
