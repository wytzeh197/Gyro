import type {
  DesktopNotificationPreferences,
  NotificationPermissionState,
} from "./types";
import { Spinner } from "./primitives";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-controls";

type DesktopNotificationSettingsProps = {
  preferences: DesktopNotificationPreferences;
  /** Undefined until macOS has answered, so nothing claims a state early. */
  permission?: NotificationPermissionState;
  isTesting: boolean;
  onChange?: (preferences: Partial<DesktopNotificationPreferences>) => void;
  onTest?: () => void;
};

/** What macOS allows right now, set beside the label. Once it is allowed the
    switch says everything, so there is no extra fact to show. */
function permissionValue(permission?: NotificationPermissionState) {
  switch (permission) {
    case undefined:
    case "granted":
      return undefined;
    case "denied":
      return "Blocked by macOS";
    case "prompt-with-rationale":
    case "prompt":
      return "Not allowed yet";
  }
}

function permissionDetail(permission?: NotificationPermissionState) {
  switch (permission) {
    case undefined:
      return "Checking whether macOS allows Gyro's notifications.";
    case "granted":
      return "Allowed by macOS. Gyro only notifies you while it's in the background.";
    case "denied":
      return "Turn on notifications for Gyro in System Settings › Notifications, then check again.";
    case "prompt-with-rationale":
    case "prompt":
      return "Gyro asks macOS for permission, then sends a test notification.";
  }
}

const KINDS: Array<{
  key: "approvals" | "finished" | "failed";
  label: string;
  detail: string;
}> = [
  {
    key: "approvals",
    label: "Approval requests",
    detail:
      "When a model is waiting on you. Clicking it opens the chat; commands can also be approved from the menu bar.",
  },
  {
    key: "finished",
    label: "Finished work",
    detail: "When a chat or automation completes.",
  },
  {
    key: "failed",
    label: "Failures",
    detail: "When a chat or automation stops with an error.",
  },
];

/** The macOS notification settings: a master switch, one switch per kind of
    message, and a test button. macOS has the final say, so until it allows
    Gyro no switch may look on: the first row shows the real permission and
    the step that changes it instead. */
export function DesktopNotificationSettings({
  preferences,
  permission,
  isTesting,
  onChange,
  onTest,
}: DesktopNotificationSettingsProps) {
  const allowed = permission === "granted";
  const delivering = allowed && preferences.enabled;
  const permissionAction =
    permission === "denied"
      ? isTesting
        ? "Checking..."
        : "Check again"
      : isTesting
        ? "Asking macOS..."
        : "Allow notifications";
  return (
    <SettingsGroup label="macOS notifications">
      <SettingsRow
        label="Notifications"
        value={permissionValue(permission)}
        detail={permissionDetail(permission)}
      >
        {permission === undefined ? (
          <Spinner label="Checking notification permission" />
        ) : allowed ? (
          <SettingsSwitch
            checked={preferences.enabled}
            label="Send macOS notifications"
            onChange={(enabled) => onChange?.({ enabled })}
          />
        ) : (
          <button
            className="gyro-button is-secondary"
            disabled={isTesting || !onTest}
            onClick={onTest}
            type="button"
          >
            {permissionAction}
          </button>
        )}
      </SettingsRow>
      {KINDS.map((kind) => (
        <SettingsRow key={kind.key} label={kind.label} detail={kind.detail}>
          <SettingsSwitch
            checked={delivering && preferences[kind.key]}
            disabled={!delivering}
            label={`Notify about ${kind.label.toLowerCase()}`}
            onChange={(checked) => onChange?.({ [kind.key]: checked })}
          />
        </SettingsRow>
      ))}
      {allowed ? (
        <SettingsRow
          label="Test notification"
          detail="Sends a sample so you can check how Gyro's notifications look."
        >
          <button
            className="gyro-button is-secondary"
            disabled={isTesting || !onTest}
            onClick={onTest}
            type="button"
          >
            {isTesting ? "Sending..." : "Send test"}
          </button>
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}
