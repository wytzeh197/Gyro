import type { WorkbenchMode } from "./types";
import {
  SettingsRow,
  SettingsChoice,
} from "./settings-controls";

export function WorkspaceDefaultSettings({
  mode,
  onChange,
}: {
  mode: WorkbenchMode;
  onChange?: (mode: WorkbenchMode) => void;
}) {
  return (
      <SettingsRow
        label="New chats start in"
        detail="Use the project folder directly, or give the agent a separate Git worktree and branch."
      >
        <SettingsChoice
          aria-label="Default workspace mode for new chats"
          disabled={!onChange}
          onValueChange={(value) =>
            onChange?.(value === "worktree" ? "worktree" : "local")
          }
          value={mode}
          options={[
            { value: "local", label: "Project folder" },
            { value: "worktree", label: "Agent workspace" },
          ]}
        />
      </SettingsRow>
  );
}
