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
      return "Allowed by macOS. Notifications appear while Gyro is in the background.";
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

/** The macOS notification settings: a master switch, one switch per kind of
    message, and the permission row with its test button. */
export function DesktopNotificationSettings({
  preferences,
  permission,
  isTesting,
  onChange,
  onTest,
}: DesktopNotificationSettingsProps) {
  return (
    <SettingsGroup
      label="macOS notifications"
      description="Choose what needs your attention while work runs in the background."
    >
      <SettingsRow label="Notifications" detail={permissionDetail(permission)}>
        <SettingsSwitch
          checked={preferences.enabled}
          label="Send macOS notifications"
          onChange={(enabled) => onChange?.({ enabled })}
        />
      </SettingsRow>
      {KINDS.map((kind) => (
        <SettingsRow key={kind.key} label={kind.label} detail={kind.detail}>
          <SettingsSwitch
            checked={preferences.enabled && preferences[kind.key]}
            disabled={!preferences.enabled}
            label={`Notify about ${kind.label.toLowerCase()}`}
            onChange={(checked) => onChange?.({ [kind.key]: checked })}
          />
        </SettingsRow>
      ))}
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
    </SettingsGroup>
  );
}
