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
    label: "View: Search Workspace",
    description: "Search project content",
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
] as const;

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
