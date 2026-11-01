import type { ReactNode } from "react";
import { ArrowLeft, Terminal, X } from "lucide-react";
import type { TerminalPane, TerminalPaneStatus } from "./types";

type SessionStatus = TerminalPaneStatus | "idle";
const statusLabels: Record<SessionStatus, string> = {
  restored: "Stopped",
  running: "Running",
  waiting: "Needs input",
  done: "Finished",
  failed: "Failed",
  idle: "Idle",
};

export function CliSessionList({
  items,
  selectedId,
  onBack,
  onSelect,
  onClose,
}: {
  items: { pane: TerminalPane; status: SessionStatus; icon?: ReactNode }[];
  selectedId?: string;
  onBack: () => void;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
}) {
  return (
    <section className="gyro-cli-sidebar-list" aria-label="CLI sessions">
      <button
        className="gyro-sidebar-action gyro-cli-back"
        onClick={onBack}
        type="button"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        <span>Back to chats</span>
      </button>
      {items.length > 0 ? (
        <div className="gyro-cli-list-heading">
          <span>Open terminals</span>
          <span className="gyro-cli-list-count">{items.length}</span>
        </div>
      ) : null}
      {items.map(({ pane, status, icon }) => {
        const title = pane.taskTitle ?? pane.title;
        const directory = pane.workingDirectory || pane.projectPath;
        const folder = directory
          ?.replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop();
        return (
          <div className="gyro-cli-sidebar-item" key={pane.id}>
            <button
              className={`gyro-cli-sidebar-select${pane.id === selectedId ? " is-active" : ""}`}
              onClick={() => onSelect?.(pane.id)}
              type="button"
              title={`${title} · ${statusLabels[status]}${directory ? ` · ${directory}` : ""}`}
              aria-current={pane.id === selectedId ? "true" : undefined}
            >
              {icon ?? <Terminal size={16} aria-hidden="true" />}
              <span className="gyro-cli-session-copy">
                <strong>{title}</strong>
                <span className="gyro-cli-session-meta" aria-live="polite">
                  <i className={`gyro-ring is-${status}`} aria-hidden="true" />
                  <span>{statusLabels[status]}</span>
                  {folder ? (
                    <span className="gyro-cli-session-folder"> · {folder}</span>
                  ) : null}
                </span>
              </span>
            </button>
            <button
              className="gyro-cli-sidebar-close"
              onClick={() => onClose?.(pane.id)}
              aria-label={`Close ${title}`}
              title={`Close ${title}`}
              type="button"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
