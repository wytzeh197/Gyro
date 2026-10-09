import { Folder } from "./workspace-folder-icons";
import { MoreHorizontal, Plus } from "lucide-react";
import type { WorkbenchMode } from "./types";
import {
  workspaceModeShortLabel,
  workspaceModeTechnicalHint,
} from "./workspace-mode";

type WorkspaceHeaderProps = {
  title: string;
  subtitle: string;
  workspacePath?: string;
  onOpenWorkspace: () => void;
  onCreateSession: () => void;
  onMoreActions?: () => void;
  activityLabel?: string;
  statusItems?: TopbarStatusItem[];
  workspaceMode?: WorkbenchMode;
  onWorkspaceModeChange?: (mode: WorkbenchMode) => void;
  showWorkspaceActions?: boolean;
};

type TopbarStatusItem = {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

export function WorkspaceHeader({
  title,
  subtitle,
  workspacePath,
  onOpenWorkspace,
  onCreateSession,
  onMoreActions,
  activityLabel = "approval waiting",
  statusItems,
  workspaceMode,
  onWorkspaceModeChange,
  showWorkspaceActions = true,
}: WorkspaceHeaderProps) {
  const visibleStatusItems =
    statusItems && statusItems.length > 0
      ? statusItems
      : [{ label: "Activity", value: activityLabel, tone: "warning" as const }];

  return (
    <header className="gyro-topbar" data-tauri-drag-region>
      <div className="gyro-title-stack" data-tauri-drag-region>
        <div className="gyro-surface-title" data-tauri-drag-region>
          <span>{title}</span>
          <button
            aria-label="More title actions"
            className="gyro-title-more"
            onClick={onMoreActions}
            title="More"
            type="button"
          >
            <MoreHorizontal size={17} />
          </button>
        </div>
        <div className="gyro-workspace-path" data-tauri-drag-region>
          {workspacePath ?? subtitle}
        </div>
      </div>
      {showWorkspaceActions ? (
        <div className="gyro-toolbar-actions">
          {workspaceMode && onWorkspaceModeChange ? (
            <div className="gyro-mode-toggle" aria-label="Session mode">
              {(["local", "worktree"] as WorkbenchMode[]).map((mode) => (
                <button
                  aria-pressed={workspaceMode === mode}
                  className={workspaceMode === mode ? "is-active" : ""}
                  key={mode}
                  onClick={() => onWorkspaceModeChange(mode)}
                  title={workspaceModeTechnicalHint(mode)}
                  type="button"
                >
                  {workspaceModeShortLabel(mode)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="gyro-topbar-status" aria-label="Workbench status">
            {visibleStatusItems.map((item) => (
              <span
                className={`gyro-status-chip is-${item.tone ?? "neutral"}`}
                key={`${item.label}-${item.value}`}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
          <button
            aria-label="Open workspace"
            className="gyro-icon-button"
            onClick={onOpenWorkspace}
            title="Open workspace"
            type="button"
          >
            <Folder size={17} />
          </button>
          <button
            className="gyro-primary-button"
            onClick={onCreateSession}
            type="button"
          >
            <Plus size={16} />
            New thread
          </button>
        </div>
      ) : null}
    </header>
  );
}
