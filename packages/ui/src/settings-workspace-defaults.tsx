import type { WorkbenchMode } from "./types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./settings-controls";

export function WorkspaceDefaultSettings({
  mode,
  onChange,
}: {
  mode: WorkbenchMode;
  onChange?: (mode: WorkbenchMode) => void;
}) {
  return (
    <SettingsGroup
      label="New chats"
      description="Applies to new chats across Gyro. Existing chats keep their workspace."
    >
      <SettingsRow
        label="New chats start in"
        detail="Use the project folder directly, or give the agent a separate Git worktree and branch."
      >
        <SettingsSelect
          aria-label="Default workspace mode for new chats"
          disabled={!onChange}
          onChange={(event) =>
            onChange?.(event.target.value === "worktree" ? "worktree" : "local")
          }
          value={mode}
        >
          <option value="local">Project folder</option>
          <option value="worktree">Agent workspace</option>
        </SettingsSelect>
      </SettingsRow>
    </SettingsGroup>
  );
}
