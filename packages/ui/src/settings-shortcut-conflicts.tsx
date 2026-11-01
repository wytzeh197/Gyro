import { SettingsGroup, SettingsRow } from "./settings-controls";
import { workspaceCommandRegistry } from "./workspace-shell";
import type { WorkspaceKeybinding } from "./types";
export function ShortcutConflicts({
  keybindings = {},
  onChange,
}: {
  keybindings?: Record<string, WorkspaceKeybinding | null>;
  onChange?: (id: string, binding?: WorkspaceKeybinding | null) => void;
}) {
  const rows = workspaceCommandRegistry.map((command) => ({
    command,
    binding:
      command.id in keybindings ? keybindings[command.id] : command.keybinding,
  }));
  const conflicts = rows.filter(
    (row) =>
      row.binding &&
      rows.some(
        (other) =>
          other.command.id !== row.command.id &&
          other.binding &&
          workspaceKeybindingSignature(other.binding) ===
            workspaceKeybindingSignature(row.binding!),
      ),
  );
  const overrides = Object.keys(keybindings);
  return (
    <SettingsGroup
      id="conflicts-reset"
      label="Conflicts & reset"
      summary={
        conflicts.length
          ? `${conflicts.length} conflicting shortcuts`
          : `No conflicts · ${overrides.length} customized`
      }
    >
      {conflicts.map(({ command }) => (
        <p key={command.id} role="alert">
          {command.label} shares a shortcut. Choose another combination in
          Workspace shortcuts.
        </p>
      ))}
      <SettingsRow
        label="Reset customized shortcuts"
        detail="Restore the built-in workspace shortcuts. App shortcuts are unchanged."
      >
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!onChange || !overrides.length}
          onClick={() => overrides.forEach((id) => onChange?.(id, undefined))}
        >
          Reset shortcuts
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function workspaceKeybindingSignature(binding: WorkspaceKeybinding) {
  return [
    binding.primary ? "primary" : "",
    binding.control ? "control" : "",
    binding.shift ? "shift" : "",
    binding.alt ? "alt" : "",
    binding.key.toLowerCase(),
  ].join("+");
}
