import { createContext, useContext } from "react";
import { ChevronRight, LoaderCircle, ShieldCheck, X } from "lucide-react";
import "./check-work-status.css";

export const CheckWorkContext = createContext<
  ((sessionId: string) => void) | undefined
>(undefined);

export type CheckWorkActivity = {
  running: boolean;
  label: string;
  detail: string;
  open: () => void;
  stop: () => void;
  dismiss: () => void;
};

export const CheckWorkActivityContext = createContext<
  Record<string, CheckWorkActivity>
>({});

/** Belongs to the chat, so another chat never inherits its running check. */
export function CheckWorkStatus({ sessionId }: { sessionId?: string }) {
  const activities = useContext(CheckWorkActivityContext);
  const activity = sessionId ? activities[sessionId] : undefined;
  if (!activity) return null;
  const Icon = activity.running ? LoaderCircle : ShieldCheck;
  return (
    <aside
      className="gyro-check-strip"
      data-running={activity.running}
      aria-label="Gyro Check status"
    >
      <Icon className="gyro-check-strip-icon" size={16} aria-hidden="true" />
      <div className="gyro-check-strip-copy" role="status">
        <div>
          <strong>Gyro Check</strong>
          <span>{activity.label}</span>
        </div>
        <p title={activity.detail}>{activity.detail}</p>
      </div>
      <button type="button" onClick={activity.open}>
        Details <ChevronRight size={13} aria-hidden="true" />
      </button>
      {activity.running ? (
        <button type="button" onClick={activity.stop}>
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={activity.dismiss}
          aria-label="Dismiss Check status"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </aside>
  );
}

export function CheckWorkMenuItem({
  sessionId,
  disabled,
  onClose,
}: {
  sessionId: string;
  disabled?: boolean;
  onClose: () => void;
}) {
  const open = useContext(CheckWorkContext);
  if (!open) return null;
  return (
    <button
      disabled={disabled}
      onClick={() => {
        onClose();
        open(sessionId);
      }}
      role="menuitem"
      type="button"
    >
      <ShieldCheck aria-hidden="true" size={14} />
      Check this work
    </button>
  );
}
