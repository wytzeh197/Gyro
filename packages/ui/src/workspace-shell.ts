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
      label: "Source control",
      icon: "source-control",
      order: 30,
      placement: "primary",
      requiresWorkspace: true,
    },
    {
      id: "run-test",
      label: "Run and test",
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
    { id: "test-results", label: "Test results", icon: "run-test", order: 50 },
    { id: "output", label: "Output", icon: "output", order: 60 },
  ] as const;

export const workspaceCommandRegistry: readonly WorkspaceCommandDefinition[] = [
  {
    id: "open-workspace",
    label: "Workspace: Open project",
    description: "Choose a local project folder",
    icon: "explorer",
    keywords: "workspace root folder add",
    destination: "workspace",
    layout: "code",
  },
  {
    id: "toggle-workspace-trust",
    label: "Workspace: Toggle restricted mode",
    description: "Allow or pause executable project features",
    icon: "settings",
    keywords: "trust security safe commands",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "add-workspace-folder",
    label: "Workspace: Add folder",
    description: "Add another project root to this workspace",
    icon: "explorer",
    keywords: "multi root project folder",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "open-workspace-file",
    label: "Workspace: Open workspace file",
    description: "Open a saved multi-root workspace definition",
    icon: "explorer",
    keywords: "gyro workspace json multi root",
    destination: "workspace",
    layout: "code",
  },
  {
    id: "save-workspace-file",
    label: "Workspace: Save workspace as",
    description: "Save the current folder set as a workspace file",
    icon: "explorer",
    keywords: "gyro workspace json multi root",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-explorer",
    label: "View: Show explorer",
    description: "Open the explorer view container",
    icon: "explorer",
    keywords: "files tree",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "search-files",
    label: "View: Search in files",
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
    label: "View: Show source control",
    description: "Open the source control view container",
    icon: "source-control",
    keywords: "git scm changes",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-run-test",
    label: "View: Show run and test",
    description: "Open tasks, tests, and debug sessions",
    icon: "run-test",
    keywords: "tasks tests debug",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "view-ai",
    label: "View: Show AI tools",
    description: "Open workspace AI tools and activity",
    icon: "ai",
    keywords: "agent assistant tools",
    destination: "workspace",
    layout: "code",
    requiresWorkspace: true,
  },
  {
    id: "new-terminal",
    label: "Terminal: Create new terminal",
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
    label: "Terminal: Split terminal",
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
    label: "View: Show diff",
    description: "Review workspace changes",
    icon: "diff",
    destination: "workspace",
    layout: "code",
    panel: "diff",
    requiresWorkspace: true,
  },
  {
    id: "open-browser-preview",
    label: "View: Show browser preview",
    description: "Inspect a local web application",
    icon: "browser",
    destination: "workspace",
    layout: "code",
    panel: "browser",
    requiresWorkspace: true,
  },
  {
    id: "show-problems",
    label: "View: Show problems",
    description: "Inspect workspace diagnostics",
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
    label: "View: Show output",
    description: "Inspect workspace output channels",
    icon: "output",
    destination: "workspace",
    layout: "code",
    panel: "output",
    requiresWorkspace: true,
  },
  {
    id: "run-tests",
    label: "Test: Run workspace tests",
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

export type KeybindingPlatform = "mac" | "other";

/** Two bindings collide when every modifier and the key match. */
export function workspaceKeybindingSignature(binding: WorkspaceKeybinding) {
  return [
    binding.primary ? "primary" : "",
    binding.control ? "control" : "",
    binding.shift ? "shift" : "",
    binding.alt ? "alt" : "",
    binding.key.toLowerCase(),
  ].join("+");
}

const macKeyNames: Readonly<Record<string, string>> = {
  " ": "Space",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  backspace: "⌫",
  delete: "⌦",
  end: "↘",
  enter: "↩",
  escape: "⎋",
  home: "↖",
  pagedown: "⇟",
  pageup: "⇞",
  tab: "⇥",
};

const otherKeyNames: Readonly<Record<string, string>> = {
  " ": "Space",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  escape: "Esc",
  pagedown: "PageDown",
  pageup: "PageUp",
};

/**
 * The one notation every shortcut in Gyro is shown in. On a Mac the modifiers
 * are the menu glyphs in Apple's order -- ⌃ ⌥ ⇧ ⌘ -- run together with the
 * key, as in ⇧⌘F. Elsewhere they are words joined by "+", as in Ctrl+Shift+F.
 */
export function formatWorkspaceKeybinding(
  binding: WorkspaceKeybinding,
  platform: KeybindingPlatform,
) {
  const key = binding.key.toLowerCase();
  const keyLabel =
    (platform === "mac" ? macKeyNames : otherKeyNames)[key] ??
    (key.length === 1
      ? key.toUpperCase()
      : key.charAt(0).toUpperCase() + key.slice(1));
  if (platform === "mac") {
    return [
      binding.control ? "⌃" : "",
      binding.alt ? "⌥" : "",
      binding.shift ? "⇧" : "",
      binding.primary ? "⌘" : "",
      keyLabel,
    ].join("");
  }
  return [
    binding.primary || binding.control ? "Ctrl" : "",
    binding.alt ? "Alt" : "",
    binding.shift ? "Shift" : "",
    keyLabel,
  ]
    .filter(Boolean)
    .join("+");
}
