import type {
  DesktopNotificationPreferences,
  NotificationPermissionState,
} from "./types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
} from "./settings-controls";
import { Bell } from "lucide-react";

type DesktopNotificationSettingsProps = {
  preferences: DesktopNotificationPreferences;
  permission: NotificationPermissionState;
  isTesting: boolean;
  onChange?: (preferences: Partial<DesktopNotificationPreferences>) => void;
  onTest?: () => void;
};

function permissionDetail(permission: NotificationPermissionState) {
  switch (permission) {
    case "granted":
      return undefined;
    case "denied":
      return "Blocked by macOS. Change Gyro's notification access in System Settings.";
    case "prompt-with-rationale":
    case "prompt":
      return "macOS permission is needed. Send a test to request access.";
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
      "When a model needs your approval. Click the notification to open its chat.",
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

/** The macOS notification settings: a master switch, then one switch per kind
    of message and a test button, which appear once notifications are on. */
export function DesktopNotificationSettings({
  preferences,
  permission,
  isTesting,
  onChange,
  onTest,
}: DesktopNotificationSettingsProps) {
  const testRow = (
    <SettingsRow
      label="Test notification"
      detail="Sends a sample so you can check how Gyro's notifications look."
    >
      <button
        className="gyro-secondary-button"
        disabled={isTesting || !onTest}
        onClick={onTest}
        type="button"
      >
        <Bell aria-hidden="true" size={13} />
        {isTesting ? "Sending..." : "Send test"}
      </button>
    </SettingsRow>
  );
  // A test is how macOS gets asked for permission, so it stays in view until then.
  const needsPermission =
    permission === "prompt" || permission === "prompt-with-rationale";
  return (
    <SettingsGroup id="macos-notifications" label="Notifications">
      <SettingsRow label="Notifications" detail={permissionDetail(permission)}>
        <SettingsSwitch
          checked={preferences.enabled}
          label="Send macOS notifications"
          onChange={(enabled) => onChange?.({ enabled })}
        />
      </SettingsRow>
      {preferences.enabled && needsPermission ? testRow : null}
      {preferences.enabled ? (
        <>
          <SettingsRow label="Show chat and project names" detail="Turn off for generic notifications that keep names private on your lock screen."><SettingsSwitch label="Show chat and project names in notifications" checked={preferences.showNames !== false} onChange={showNames => onChange?.({ showNames })}/></SettingsRow>
          {KINDS.map((kind) => (
            <SettingsRow key={kind.key} label={kind.label} detail={kind.detail}>
              <SettingsSwitch
                checked={preferences[kind.key]}
                label={`Notify about ${kind.label.toLowerCase()}`}
                onChange={(checked) => onChange?.({ [kind.key]: checked })}
              />
            </SettingsRow>
          ))}
          {needsPermission ? null : testRow}
        </>
      ) : null}
    </SettingsGroup>
  );
}
