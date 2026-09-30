import { useId, useState, type KeyboardEvent } from "react";
import { RotateCcw } from "lucide-react";
import type { WorkspaceKeybinding } from "./types";
import { EmptyState } from "./primitives";
import { SettingsGroup, SettingsRow } from "./settings-controls";
import {
  formatWorkspaceKeybinding,
  workspaceCommandRegistry,
  workspaceKeybindingSignature,
  type KeybindingPlatform,
  type WorkspaceCommandDefinition,
} from "./workspace-shell";

/**
 * Settings > Keyboard.
 *
 * Workspace commands are editable: focus a shortcut and press the new keys.
 * The built-in list mirrors the fixed shortcuts App.tsx handles in its global
 * keydown listener. Both lists print keys through formatWorkspaceKeybinding so
 * the page shows one notation. This lives beside surfaces.tsx because that
 * file sits at its architecture ceiling.
 */

type ShortcutRow = {
  name: string;
  detail: string;
  binding: WorkspaceKeybinding;
};

const builtInShortcutGroups: Array<{ label: string; rows: ShortcutRow[] }> = [
  {
    label: "Navigation",
    rows: [
      {
        name: "Command palette",
        detail: "Type a command to run it",
        binding: { key: "p", primary: true, shift: true },
      },
      {
        name: "Search everything",
        detail: "Search files, projects, chats, and actions",
        binding: { key: "k", primary: true },
      },
      {
        name: "Find files",
        detail: "Search files by name",
        binding: { key: "p", primary: true },
      },
      {
        name: "Open settings",
        detail: "Go to Settings",
        binding: { key: ",", primary: true },
      },
    ],
  },
  {
    label: "Chats",
    rows: [
      {
        name: "New chat",
        detail: "Start a new chat",
        binding: { key: "n", primary: true },
      },
      {
        name: "Show chats",
        detail: "Switch to the chat view",
        binding: { key: "1", primary: true },
      },
      {
        name: "Show terminals",
        detail: "Switch to the terminal grid",
        binding: { key: "2", primary: true },
      },
      {
        name: "Show Workspace",
        detail: "Switch to the Workspace editor",
        binding: { key: "3", primary: true },
      },
    ],
  },
  {
    label: "Editor",
    rows: [
      {
        name: "Save file",
        detail: "Save the open file in the Workspace editor",
        binding: { key: "s", primary: true },
      },
    ],
  },
  {
    label: "Terminal",
    rows: [
      {
        name: "New terminal",
        detail: "Open a new terminal pane",
        binding: { key: "t", primary: true },
      },
    ],
  },
];

function keybindingPlatform(): KeybindingPlatform {
  return typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
    ? "mac"
    : "other";
}

/** "View: Show Explorer" is listed as "Show Explorer" under a View heading. */
function commandParts(command: WorkspaceCommandDefinition) {
  const separator = command.label.indexOf(": ");
  return separator > 0
    ? {
        group: command.label.slice(0, separator),
        name: command.label.slice(separator + 2),
      }
    : { group: "Other", name: command.label };
}

function matchesTerms(terms: string[], ...fields: string[]) {
  const text = fields.join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

export function WorkspaceKeyboardSettings({
  keybindings = {},
  onKeybindingChange,
}: {
  keybindings?: Record<string, WorkspaceKeybinding | null>;
  onKeybindingChange?: (
    commandId: string,
    binding?: WorkspaceKeybinding | null,
  ) => void;
}) {
  const platform = keybindingPlatform();
  const mac = platform === "mac";
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string>();
  const [bindingError, setBindingError] = useState<{
    commandId: string;
    message: string;
  }>();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

  const bindingFor = (command: WorkspaceCommandDefinition) =>
    command.id in keybindings
      ? (keybindings[command.id] ?? undefined)
      : command.keybinding;

  const editableGroups: Array<{
    label: string;
    commands: Array<{ command: WorkspaceCommandDefinition; name: string }>;
  }> = [];
  for (const command of workspaceCommandRegistry) {
    const { group, name } = commandParts(command);
    if (!matchesTerms(terms, group, name)) continue;
    let bucket = editableGroups.find((entry) => entry.label === group);
    if (!bucket) {
      bucket = { label: group, commands: [] };
      editableGroups.push(bucket);
    }
    bucket.commands.push({ command, name });
  }
  const builtInGroups = builtInShortcutGroups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) =>
        matchesTerms(terms, group.label, row.name),
      ),
    }))
    .filter((group) => group.rows.length);

  const recordShortcut = (
    command: WorkspaceCommandDefinition,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    setBindingError(undefined);
    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      onKeybindingChange?.(command.id, null);
      return;
    }
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
      return;
    }
    if (!event.metaKey && !event.ctrlKey) {
      setBindingError({
        commandId: command.id,
        message: mac
          ? "Include ⌘ or ⌃ so the shortcut doesn't get in the way of typing."
          : "Include Ctrl so the shortcut doesn't get in the way of typing.",
      });
      return;
    }
    const binding: WorkspaceKeybinding = {
      key: event.key.toLowerCase(),
      primary: mac ? event.metaKey : event.ctrlKey,
      control: mac ? event.ctrlKey : false,
      shift: event.shiftKey,
      alt: event.altKey,
    };
    if (binding.primary && ["k", "p", "s"].includes(binding.key)) {
      setBindingError({
        commandId: command.id,
        message: `${formatWorkspaceKeybinding(binding, platform)} is already used by Gyro. Choose another shortcut.`,
      });
      return;
    }
    onKeybindingChange?.(command.id, binding);
  };

  return (
    <>
      <div className="gyro-keyboard-toolbar">
        <input
          aria-label="Filter shortcuts"
          className="gyro-input gyro-keyboard-filter"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Filter shortcuts"
          type="search"
          value={query}
        />
        <p id={hintId}>
          {mac
            ? "Click a shortcut and press the new keys, including ⌘ or ⌃. Delete clears it."
            : "Click a shortcut and press the new keys, including Ctrl. Delete clears it."}
        </p>
      </div>
      <p className="gyro-sr-only" role="alert">
        {bindingError?.message ?? ""}
      </p>
      {editableGroups.map((group) => (
        <SettingsGroup key={group.label} label={group.label}>
          {group.commands.map(({ command, name }) => {
            const hasOverride = command.id in keybindings;
            const binding = bindingFor(command);
            const collision = binding
              ? workspaceCommandRegistry.find((candidate) => {
                  if (candidate.id === command.id) return false;
                  const candidateBinding = bindingFor(candidate);
                  return (
                    candidateBinding &&
                    workspaceKeybindingSignature(candidateBinding) ===
                      workspaceKeybindingSignature(binding)
                  );
                })
              : undefined;
            const error =
              bindingError?.commandId === command.id
                ? bindingError.message
                : undefined;
            const recording = recordingId === command.id;
            return (
              <SettingsRow
                detail={
                  error ??
                  (collision
                    ? `Conflicts with ${commandParts(collision).name}`
                    : command.description)
                }
                key={command.id}
                label={name}
              >
                {hasOverride ? (
                  <button
                    aria-label={`Reset shortcut for ${name}`}
                    className="gyro-icon-button is-small"
                    onClick={() => {
                      setBindingError(undefined);
                      onKeybindingChange?.(command.id, undefined);
                    }}
                    title="Reset to default"
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" size={13} />
                  </button>
                ) : null}
                <div className="gyro-keybinding-field">
                  <input
                    aria-describedby={hintId}
                    aria-invalid={error || collision ? true : undefined}
                    aria-label={`Shortcut for ${name}`}
                    className="gyro-keybinding-input"
                    onBlur={() => {
                      setRecordingId((current) =>
                        current === command.id ? undefined : current,
                      );
                      setBindingError((current) =>
                        current?.commandId === command.id ? undefined : current,
                      );
                    }}
                    onFocus={() => setRecordingId(command.id)}
                    onKeyDown={(event) => recordShortcut(command, event)}
                    placeholder={recording ? "Press keys" : "Set shortcut"}
                    readOnly
                    value={
                      binding
                        ? formatWorkspaceKeybinding(binding, platform)
                        : ""
                    }
                  />
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      ))}
      {builtInGroups.length ? (
        <header className="gyro-keyboard-builtin-head">
          <h2 className="gyro-settings-subheading">Built-in shortcuts</h2>
          <p>These can't be changed.</p>
        </header>
      ) : null}
      {builtInGroups.map((group) => (
        <SettingsGroup key={group.label} label={group.label}>
          {group.rows.map((row) => (
            <SettingsRow detail={row.detail} key={row.name} label={row.name}>
              <kbd className="gyro-settings-key">
                {formatWorkspaceKeybinding(row.binding, platform)}
              </kbd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
      {!editableGroups.length && !builtInGroups.length ? (
        <EmptyState
          compact
          role="status"
          title={`No shortcuts match “${query.trim()}”`}
        />
      ) : null}
    </>
  );
}
