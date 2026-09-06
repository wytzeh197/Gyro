import { Check, FileText, Folder, ShieldCheck, X } from "lucide-react";
import { useId, type ReactNode } from "react";

type ApprovalStatus =
  "pending" | "approved" | "applied" | "rejected" | "cancelled" | "failed";

/** A decision stays with its explanation in the transcript, never in the composer. */
export function InlineApprovalCard({
  title,
  icon,
  description,
  command,
  files = [],
  cwd,
  scope,
  error,
  status,
  actions,
}: {
  title: string;
  icon: ReactNode;
  description: string;
  command?: string;
  files?: Array<{ path: string; diff?: string }>;
  cwd?: string;
  scope?: string;
  error?: string;
  status: ApprovalStatus;
  actions: ReactNode;
}) {
  const titleId = useId();
  const statusLabel = {
    pending: "Waiting for your approval",
    approved: "Approved",
    applied: "Applied",
    rejected: "Rejected",
    cancelled: "Cancelled",
    failed: error?.includes("expired")
      ? "Expired — request approval again"
      : "Could not complete this action",
  }[status];
  return (
    <article
      aria-labelledby={titleId}
      className={`gyro-inline-approval is-${status}`}
    >
      <div className="gyro-inline-approval-body">
        <div className="gyro-inline-approval-heading">
          <span className="gyro-inline-approval-icon" aria-hidden="true">
            {icon}
          </span>
          <div>
            <h3 id={titleId}>{title}</h3>
            {description ? <p>{description}</p> : null}
          </div>
        </div>
        {command ? (
          <pre className="gyro-inline-approval-command">
            <code>{command}</code>
          </pre>
        ) : null}
        {files.length ? (
          <div className="gyro-inline-approval-files">
            {files.map((file, index) => (
              <div key={`${file.path}:${index}`}>
                <span>
                  <FileText size={14} aria-hidden="true" />
                  <code>{file.path}</code>
                </span>
                {file.diff ? (
                  <details>
                    <summary>Review changes</summary>
                    <pre>{file.diff}</pre>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {cwd ? (
          <div className="gyro-inline-approval-context">
            <Folder size={14} aria-hidden="true" />
            <span>
              In <code>{cwd}</code>
            </span>
          </div>
        ) : null}
        {scope ? (
          <div className="gyro-inline-approval-context">
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{scope}</span>
          </div>
        ) : null}
        {error ? (
          <p className="gyro-inline-approval-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="gyro-inline-approval-footer">
        <span className="gyro-inline-approval-status" role="status">
          {status === "approved" || status === "applied" ? (
            <Check size={15} />
          ) : status === "rejected" || status === "cancelled" ? (
            <X size={15} />
          ) : (
            <ShieldCheck size={15} />
          )}
          {statusLabel}
        </span>
        {status === "pending" ? (
          <div className="gyro-inline-approval-actions">{actions}</div>
        ) : null}
      </footer>
    </article>
  );
}
