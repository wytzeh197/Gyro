import type {
  AppDestination,
  IdeViewId,
  WorkbenchPaneTab,
  WorkspaceKeybinding,
  WorkspaceLayoutId,
} from "./types";

export type WorkspaceShellIcon =
  | "ai"
  | "browser"
  | "diff"
  | "editor"
  | "explorer"
  | "output"
  | "problems"
  | "run-test"
  | "search"
  | "settings"
  | "source-control"
  | "terminal";

export type WorkspaceViewContainerContribution = {
  id: IdeViewId;
  label: string;
  icon: WorkspaceShellIcon;
  order: number;
  placement: "primary" | "secondary";
  requiresWorkspace: boolean;
};

export type WorkspacePanelContribution = {
  id: WorkbenchPaneTab;
  label: string;
  icon: WorkspaceShellIcon;
  order: number;
};

export type WorkspaceCommandDefinition = {
  id: string;
  label: string;
  description: string;
  icon: WorkspaceShellIcon;
  keywords?: string;
  destination?: AppDestination;
  layout?: WorkspaceLayoutId;
  panel?: WorkbenchPaneTab;
  shortcut?: { mac: string; other: string };
  keybinding?: WorkspaceKeybinding;
  requiresWorkspace?: boolean;
  requiresTrust?: boolean;
};

export const workspaceViewContainers: readonly WorkspaceViewContainerContribution[] =
  [
    {
      id: "explorer",
      label: "Explorer",
      icon: "explorer",
      order: 10,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "search",
      label: "Search",
      icon: "search",
      order: 20,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "source-control",
      label: "Source Control",
      icon: "source-control",
      order: 30,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "run-test",
      label: "Run and Test",
      icon: "run-test",
      order: 40,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "ai",
      label: "AI",
      icon: "ai",
      order: 50,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "settings",
      label: "Settings",
      icon: "settings",
      order: 100,
      placement: "secondary",
      requiresWorkspace: false,
    },
  ] as const;

export const workspacePanelContributions: readonly WorkspacePanelContribution[] =
  [
    { id: "diff", label: "Diff", icon: "diff", order: 10 },
    { id: "terminal", label: "Terminal", icon: "terminal", order: 20 },
    { id: "browser", label: "Browser", icon: "browser", order: 30 },
    { id: "problems", label: "Problems", icon: "problems", order: 40 },
    { id: "test-results", label: "Test Results", icon: "run-test", order: 50 },
    { id: "output", label: "Output", icon: "output", order: 60 },
  ] as const;

export const workspaceCommandRegistry: readonly WorkspaceCommandDefinition[] = [
  {
    id: "open-workspace",
    label: "Workspace: Open Project",
    description: "Choose a local project folder",
    icon: "explorer",
    keywords: "workspace root folder add",
    destination: "workspace",
    layout: "code",
  },
  {
    id: "toggle-workspace-trust",
    label: "Workspace: Toggle Restricted Mode",
    description: "Allow or pause executable project features",
    icon: "settings",
    keywords: "trust security safe commands",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "add-workspace-folder",
    label: "Workspace: Add Folder",
    description: "Add another project root to this workspace",
    icon: "explorer",
    keywords: "multi root project folder",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "open-workspace-file",
    label: "Workspace: Open Workspace File",
    description: "Open a saved multi-root workspace definition",
    icon: "explorer",
    keywords: "gyro workspace json multi root",
    destination: "workspace",
    layout: "code",
  },
  {
    id: "save-workspace-file",
    label: "Workspace: Save Workspace As",
    description: "Save the current folder set as a workspace file",
    icon: "explorer",
    keywords: "gyro workspace json multi root",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-explorer",
    label: "View: Show Explorer",
    description: "Open the Explorer view container",
    icon: "explorer",
    keywords: "files tree",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "search-files",
    label: "View: Search in Files",
    description: "Find text across the workspace",
    icon: "search",
    keywords: "code find text",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌘F", other: "Ctrl Shift F" },
    keybinding: { key: "f", primary: true, shift: true },
    requiresWorkspace: true,
  },
  {
    id: "view-source-control",
    label: "View: Show Source Control",
    description: "Open the Source Control view container",
    icon: "source-control",
    keywords: "git scm changes",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-run-test",
    label: "View: Show Run and Test",
    description: "Open tasks, tests, and debug sessions",
    icon: "run-test",
    keywords: "tasks tests debug",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-ai",
    label: "View: Show AI Tools",
    description: "Open Workspace AI tools and activity",
    icon: "ai",
    keywords: "agent assistant tools",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "new-terminal",
    label: "Terminal: Create New Terminal",
    description: "Open a local shell pane",
    icon: "terminal",
    keywords: "shell console",
    destination: "workspace",
    layout: "code",
    panel: "terminal",
    shortcut: { mac: "⌃⇧`", other: "Ctrl Shift `" },
    keybinding: { key: "`", control: true, shift: true },
    requiresWorkspace: true,
    requiresTrust: true,
  },
  {
    id: "split-terminal",
    label: "Terminal: Split Terminal",
    description: "Split the active terminal pane",
    icon: "terminal",
    destination: "workspace",
    layout: "code",
    panel: "terminal",
    shortcut: { mac: "⌘\\", other: "Ctrl \\" },
    keybinding: { key: "\\", primary: true },
    requiresWorkspace: true,
    requiresTrust: true,
  },
  {
    id: "show-diffs",
    label: "View: Show Diff",
    description: "Review Workspace changes",
    icon: "diff",
    destination: "workspace",
    layout: "code",
    panel: "diff",
    requiresWorkspace: true,
  },
  {
    id: "open-browser-preview",
    label: "View: Show Browser Preview",
    description: "Inspect a local web application",
    icon: "browser",
    destination: "workspace",
    layout: "code",
    panel: "browser",
    requiresWorkspace: true,
  },
  {
    id: "show-problems",
    label: "View: Show Problems",
    description: "Inspect Workspace diagnostics",
    icon: "problems",
    destination: "workspace",
    layout: "code",
    panel: "problems",
    shortcut: { mac: "⇧⌘M", other: "Ctrl Shift M" },
    keybinding: { key: "m", primary: true, shift: true },
    requiresWorkspace: true,
  },
  {
    id: "show-output",
    label: "View: Show Output",
    description: "Inspect Workspace output channels",
    icon: "output",
    destination: "workspace",
    layout: "code",
    panel: "output",
    requiresWorkspace: true,
  },
  {
    id: "run-tests",
    label: "Test: Run Workspace Tests",
    description: "Run the detected test task",
    icon: "run-test",
    keywords: "validate check",
    destination: "workspace",
    layout: "code",
    panel: "terminal",
    requiresWorkspace: true,
    requiresTrust: true,
  },
  {
    id: "editor.action.quickOutline",
    label: "Editor: Go to Symbol in Editor…",
    description: "Jump to a function, class or heading in this file",
    icon: "editor",
    keywords: "editor symbol outline @ navigate",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌘O", other: "Ctrl Shift O" },
    keybinding: { key: "o", primary: true, shift: true },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.gotoLine",
    label: "Editor: Go to Line/Column…",
    description: "Move the cursor to a line number",
    icon: "editor",
    keywords: "editor jump navigate",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌃G", other: "Ctrl G" },
    keybinding: { key: "g", control: true },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.formatDocument",
    label: "Editor: Format Document",
    description: "Format the whole file with its language server",
    icon: "editor",
    keywords: "editor prettier rustfmt indent tidy",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌥F", other: "Shift Alt F" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.formatSelection",
    label: "Editor: Format Selection",
    description: "Format the selected lines",
    icon: "editor",
    keywords: "editor prettier indent tidy",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘K ⌘F", other: "Ctrl K Ctrl F" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.commentLine",
    label: "Editor: Toggle Line Comment",
    description: "Comment or uncomment the selected lines",
    icon: "editor",
    keywords: "editor comment uncomment",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘/", other: "Ctrl /" },
    keybinding: { key: "/", primary: true },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.blockComment",
    label: "Editor: Toggle Block Comment",
    description: "Wrap the selection in a block comment",
    icon: "editor",
    keywords: "editor comment",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌥A", other: "Shift Alt A" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.moveLinesUpAction",
    label: "Editor: Move Line Up",
    description: "Move the selected lines up",
    icon: "editor",
    keywords: "editor reorder",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥↑", other: "Alt Up" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.moveLinesDownAction",
    label: "Editor: Move Line Down",
    description: "Move the selected lines down",
    icon: "editor",
    keywords: "editor reorder",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥↓", other: "Alt Down" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.copyLinesDownAction",
    label: "Editor: Copy Line Down",
    description: "Duplicate the selected lines below",
    icon: "editor",
    keywords: "editor duplicate",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌥↓", other: "Shift Alt Down" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.deleteLines",
    label: "Editor: Delete Line",
    description: "Delete the selected lines",
    icon: "editor",
    keywords: "editor remove",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧⌘K", other: "Ctrl Shift K" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.addSelectionToNextFindMatch",
    label: "Editor: Add Selection to Next Find Match",
    description: "Add a cursor at the next occurrence",
    icon: "editor",
    keywords: "editor multi cursor occurrence",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘D", other: "Ctrl D" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.insertCursorAbove",
    label: "Editor: Add Cursor Above",
    description: "Add a cursor on the line above",
    icon: "editor",
    keywords: "editor multi cursor",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥⌘↑", other: "Ctrl Alt Up" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.insertCursorBelow",
    label: "Editor: Add Cursor Below",
    description: "Add a cursor on the line below",
    icon: "editor",
    keywords: "editor multi cursor",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥⌘↓", other: "Ctrl Alt Down" },
    requiresWorkspace: true,
  },
  {
    id: "editor.fold",
    label: "Editor: Fold",
    description: "Collapse the region at the cursor",
    icon: "editor",
    keywords: "editor collapse region",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥⌘[", other: "Ctrl Shift [" },
    requiresWorkspace: true,
  },
  {
    id: "editor.unfold",
    label: "Editor: Unfold",
    description: "Expand the region at the cursor",
    icon: "editor",
    keywords: "editor expand region",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥⌘]", other: "Ctrl Shift ]" },
    requiresWorkspace: true,
  },
  {
    id: "editor.foldAll",
    label: "Editor: Fold All",
    description: "Collapse every region in the file",
    icon: "editor",
    keywords: "editor collapse regions",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘K ⌘0", other: "Ctrl K Ctrl 0" },
    requiresWorkspace: true,
  },
  {
    id: "editor.unfoldAll",
    label: "Editor: Unfold All",
    description: "Expand every region in the file",
    icon: "editor",
    keywords: "editor expand regions",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘K ⌘J", other: "Ctrl K Ctrl J" },
    requiresWorkspace: true,
  },
  {
    id: "actions.find",
    label: "Editor: Find",
    description: "Find in this file",
    icon: "editor",
    keywords: "editor search",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘F", other: "Ctrl F" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.startFindReplaceAction",
    label: "Editor: Replace",
    description: "Find and replace in this file",
    icon: "editor",
    keywords: "editor search",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌥⌘F", other: "Ctrl H" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.revealDefinition",
    label: "Editor: Go to Definition",
    description: "Open the definition of the symbol at the cursor",
    icon: "editor",
    keywords: "editor navigate lsp",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "F12", other: "F12" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.goToReferences",
    label: "Editor: Go to References",
    description: "List references to the symbol at the cursor",
    icon: "editor",
    keywords: "editor usages lsp",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⇧F12", other: "Shift F12" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.quickFix",
    label: "Editor: Quick Fix…",
    description: "Show fixes for the problem at the cursor",
    icon: "editor",
    keywords: "editor code action lightbulb",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘.", other: "Ctrl ." },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.triggerSuggest",
    label: "Editor: Trigger Suggest",
    description: "Show completions at the cursor",
    icon: "editor",
    keywords: "editor completion intellisense",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌃Space", other: "Ctrl Space" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.trimTrailingWhitespace",
    label: "Editor: Trim Trailing Whitespace",
    description: "Remove spaces at the ends of lines",
    icon: "editor",
    keywords: "editor whitespace",
    destination: "workspace",
    layout: "code",
    shortcut: { mac: "⌘K ⌘X", other: "Ctrl K Ctrl X" },
    requiresWorkspace: true,
  },
  {
    id: "editor.action.transformToUppercase",
    label: "Editor: Transform to Uppercase",
    description: "Uppercase the selection",
    icon: "editor",
    keywords: "editor case",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "editor.action.transformToLowercase",
    label: "Editor: Transform to Lowercase",
    description: "Lowercase the selection",
    icon: "editor",
    keywords: "editor case",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
] as const;

/** Commands that run a Monaco action on the most recently focused editor. */
export function isWorkspaceEditorCommand(commandId: string) {
  return commandId.startsWith("editor.") || commandId.startsWith("actions.");
}

export function workspaceCommandForKeybinding(
  event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
  platform: "mac" | "other",
  overrides?: Readonly<Record<string, WorkspaceKeybinding | null>>,
) {
  const normalizedKey = event.key.toLowerCase();
  return workspaceCommandRegistry.find((command) => {
    const binding =
      command.id in (overrides ?? {})
        ? overrides?.[command.id]
        : command.keybinding;
    if (!binding || binding.key.toLowerCase() !== normalizedKey) {
      return false;
    }
    const expectedMeta = binding.primary === true && platform === "mac";
    const expectedControl =
      binding.control === true ||
      (binding.primary === true && platform === "other");
    return (
      event.metaKey === expectedMeta &&
      event.ctrlKey === expectedControl &&
      event.shiftKey === (binding.shift === true) &&
      event.altKey === (binding.alt === true)
    );
  });
}
