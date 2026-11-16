import { isWorkspaceEditorCommand } from "@gyro-dev/ui";
import { runActiveEditorAction } from "./workspace-code-editor";

/**
 * A rebound editor shortcut pressed in the chat composer or another field
 * belongs to that field, not to the editor that last had focus.
 */
export function editorCommandWouldStealTyping(commandId: string) {
  if (!isWorkspaceEditorCommand(commandId)) return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.closest(".monaco-editor"))
    return false;
  return (
    active.isContentEditable ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement &&
      !["button", "checkbox", "radio"].includes(active.type))
  );
}

/**
 * Runs a Monaco action from the palette or a Gyro keybinding. It waits a tick
 * so the palette has closed and handed focus back; otherwise restoring focus
 * would dismiss the widget the action opens (find, rename, quick fix).
 * Returns false for ids that are not editor commands.
 */
export function runEditorCommandLater(
  commandId: string,
  onNoEditor: () => void,
) {
  if (!isWorkspaceEditorCommand(commandId)) return false;
  window.setTimeout(() => {
    if (!runActiveEditorAction(commandId)) onNoEditor();
  }, 0);
  return true;
}
