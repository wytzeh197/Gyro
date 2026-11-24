import { createContext, useContext } from "react";
import { ChevronRight, ShieldCheck, X } from "./icons";
import { Button, IconButton, LiveStatusSpinner, Menu } from "./primitives";
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
  return (
    <aside
      className="gyro-check-strip"
      data-running={activity.running}
      aria-label="Gyro Check status"
    >
      {activity.running ? (
        <LiveStatusSpinner className="gyro-check-strip-icon" size="md" />
      ) : (
        <ShieldCheck className="gyro-check-strip-icon" size={16} aria-hidden="true" />
      )}
      <div className="gyro-check-strip-copy" role="status">
        <div>
          <strong>Gyro Check</strong>
          <span>{activity.label}</span>
        </div>
        <p title={activity.detail}>{activity.detail}</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        onClick={activity.open}
        trailing={<ChevronRight size={13} aria-hidden="true" />}
      >
        Details
      </Button>
      {activity.running ? (
        <Button variant="ghost" size="xs" onClick={activity.stop}>
          Stop
        </Button>
      ) : (
        <IconButton size="xs" onClick={activity.dismiss} label="Dismiss Check status">
          <X size={14} aria-hidden="true" />
        </IconButton>
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
    <Menu.Item
      disabled={disabled}
      icon={<ShieldCheck aria-hidden="true" size={14} />}
      onClick={() => {
        onClose();
        open(sessionId);
      }}
    >
      Check this work
    </Menu.Item>
  );
}
