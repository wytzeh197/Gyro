import type { CapabilityId } from "./types.ts";

/**
 * The one table that decides what a capability call looks like in the rail.
 *
 * The Rust enum (`crates/gyro-core/src/capabilities.rs`) is the source of truth
 * for *which* capabilities exist; this file is the source of truth for what the
 * UI *says* and which row each one becomes. The `satisfies` below turns a new
 * backend id into a compile error here instead of a "Github pull requests" row
 * with a wrench, and `scripts/check-capability-labels.mjs` keeps the two lists
 * from drifting between releases.
 *
 * Titles are deliberately the settled wording, not sentences: `runRowText`
 * supplies tense, and the icon comes from `row`, so nothing here may invent a
 * ninth row kind.
 */

/** One Gyro Browser verb, so each row says what the agent did to the page. */
export type BrowserAction =
  | "open"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "inspect"
  | "read"
  | "find"
  | "console"
  | "network"
  | "capture"
  | "viewport"
  | "mouse"
  | "click"
  | "type"
  | "scroll"
  | "form";

/** The rail row — and therefore the icon — a capability call becomes. */
export type CapabilityRowKind =
  | "tool"
  | "command"
  | "search"
  | "read"
  | "file"
  | "browser";

export type CapabilityUi = {
  /** Settled title in the rail, and the name approval prompts show. */
  label: string;
  row: CapabilityRowKind;
  /** `search` rows only: the scope the row reports. */
  scope?: "project" | "web";
  /** `browser` rows only: the verb the row names. */
  action?: BrowserAction;
};

export const CAPABILITY_UI = {
  "code-mode-discover": {
    label: "Finding available workspace actions",
    row: "tool",
  },
  "code-mode-execute": { label: "Inspecting workspace", row: "tool" },

  "workspace-context": { label: "Workspace context", row: "tool" },
  "workspace-outline": { label: "Workspace outline", row: "read" },
  "task-checkpoint": { label: "Task checkpoint", row: "tool" },
  "workspace-check": { label: "Workspace check", row: "tool" },
  "workspace-list": { label: "List workspace", row: "tool" },
  "workspace-search": {
    label: "Workspace search",
    row: "search",
    scope: "project",
  },
  "workspace-read": { label: "Read file", row: "read" },
  "workspace-read-range": { label: "Read file range", row: "read" },
  "workspace-read-editor": { label: "Read editor", row: "read" },
  "workspace-diagnostics": { label: "Workspace diagnostics", row: "tool" },
  "workspace-git-status": { label: "Git status", row: "tool" },
  "workspace-diff": { label: "Workspace diff", row: "tool" },
  "workspace-git-log": { label: "Git log", row: "tool" },
  "workspace-git-show": { label: "Git show", row: "tool" },
  "workspace-git-blame": { label: "Git blame", row: "tool" },
  "workspace-propose-edit": { label: "Propose edit", row: "file" },
  "workspace-edit": { label: "Edit file", row: "file" },
  "workspace-create-path": { label: "Create path", row: "file" },
  "workspace-rename-path": { label: "Rename path", row: "file" },
  "workspace-delete-path": { label: "Delete path", row: "file" },
  "workspace-move-path": { label: "Move path", row: "file" },
  "workspace-duplicate-path": { label: "Duplicate path", row: "file" },
  "workspace-undo-path": { label: "Undo path", row: "tool" },
  "workspace-open-folder": { label: "Open folder", row: "tool" },
  "workspace-run-task": { label: "Run task", row: "command" },
  "workspace-run-test": { label: "Run tests", row: "command" },
  "workspace-read-output": { label: "Read output", row: "tool" },

  "code-definition": { label: "Go to definition", row: "read" },
  "code-references": { label: "Find references", row: "read" },
  "code-hover": { label: "Hover info", row: "read" },
  "code-symbols": { label: "File symbols", row: "read" },
  "code-format": { label: "Format file", row: "tool" },

  "ide-reveal": { label: "Reveal in editor", row: "tool" },
  "ide-open-panel": { label: "Open panel", row: "tool" },

  "terminal-open": { label: "Open terminal", row: "command" },
  "terminal-read": { label: "Read terminal", row: "command" },
  "terminal-wait": { label: "Wait for command", row: "command" },
  "terminal-stop": { label: "Stop terminal", row: "command" },

  "browser-open": { label: "Open browser", row: "browser", action: "open" },
  "browser-inspect": {
    label: "Inspect browser",
    row: "browser",
    action: "inspect",
  },
  "browser-reload": {
    label: "Reload browser",
    row: "browser",
    action: "reload",
  },
  "browser-screenshot": {
    label: "Browser screenshot",
    row: "browser",
    action: "capture",
  },
  "browser-viewport": {
    label: "Resize viewport",
    row: "browser",
    action: "viewport",
  },
  "browser-navigate": {
    label: "Navigate browser",
    row: "browser",
    action: "navigate",
  },
  "browser-back": { label: "Browser back", row: "browser", action: "back" },
  "browser-forward": {
    label: "Browser forward",
    row: "browser",
    action: "forward",
  },
  "browser-click": { label: "Browser click", row: "browser", action: "click" },
  "browser-mouse": { label: "Browser mouse", row: "browser", action: "mouse" },
  "browser-type": { label: "Browser type", row: "browser", action: "type" },
  "browser-scroll": {
    label: "Browser scroll",
    row: "browser",
    action: "scroll",
  },
  "browser-form-input": {
    label: "Browser form input",
    row: "browser",
    action: "form",
  },
  "browser-read-page": { label: "Read page", row: "browser", action: "read" },
  "browser-find": { label: "Find on page", row: "browser", action: "find" },
  "browser-console": {
    label: "Browser console",
    row: "browser",
    action: "console",
  },
  "browser-network": {
    label: "Browser network",
    row: "browser",
    action: "network",
  },

  "github-status": { label: "GitHub status", row: "tool" },
  "github-pull-requests": { label: "GitHub pull requests", row: "tool" },
  "github-workflow-runs": { label: "GitHub workflow runs", row: "tool" },
  "github-workflow-logs": { label: "GitHub workflow logs", row: "tool" },
  "github-create-pull-request": { label: "Open pull request", row: "tool" },
  "github-rerun-workflow": { label: "Re-run workflow", row: "tool" },
  "github-push": { label: "Push branch", row: "tool" },

  "web-fetch": { label: "Fetch page", row: "tool" },
  "memory-read": { label: "Read memory", row: "tool" },
  "memory-write": { label: "Remember", row: "tool" },
  "research-run": { label: "Research sub-agent", row: "tool" },
  "agent-spawn": { label: "Launch sub-agent", row: "tool" },
  "agent-wait": { label: "Wait for sub-agents", row: "tool" },
  "agent-send": { label: "Send agent task", row: "tool" },
  "agent-stop": { label: "Stop sub-agent", row: "tool" },
  "tool-catalog": { label: "Tool catalog", row: "tool" },
} as const satisfies Record<CapabilityId, CapabilityUi>;

const LOOKUP = CAPABILITY_UI as Record<string, CapabilityUi>;
const CAPABILITY_IDS = new Set<string>(Object.keys(CAPABILITY_UI));

/** The row settings for a capability id, or `undefined` for an unknown one. */
export function capabilityUi(capabilityId: string): CapabilityUi | undefined {
  return LOOKUP[capabilityId];
}

/**
 * `workspace-context` → `Workspace context`.
 *
 * Unknown ids still get a readable name — the backend may ship a capability a
 * release ahead of the UI — but the falling-back is visible here rather than
 * spread across four prefix branches.
 */
export function capabilityLabel(capabilityId: string): string {
  const known = LOOKUP[capabilityId]?.label;
  if (known) {
    return known;
  }
  const spaced = capabilityId
    .replaceAll(/[-_.]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
}

/**
 * `gyro_workspace_read_file` / `mcp__gyro_capabilities__gyro_workspace_read`
 * → `workspace-read`.
 *
 * Only the ids this table knows resolve; a provider tool that is not one of
 * Gyro's capabilities stays a provider tool.
 */
export function capabilityIdFromToolName(
  toolName: string,
): CapabilityId | undefined {
  const id = toolName
    .trim()
    .replace(/^(?:mcp__)?gyro_capabilities__/i, "")
    .replace(/^gyro_/i, "")
    .replaceAll("_", "-");
  return CAPABILITY_IDS.has(id) ? (id as CapabilityId) : undefined;
}
