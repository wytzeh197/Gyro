import { invoke } from "@tauri-apps/api/core";
import {
  getProviderModel,
  isProviderId,
  providerDefaultModelId,
  providersForConfig,
  selectedReasoningEffort,
  type GyroConfig,
  type Session,
  type WorkbenchState,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceLayoutId,
} from "@gyro-dev/ui";
import type { SessionModelSelection } from "./use-session-model-save";
import { slugify } from "./session-context-events";

export function normalizeSessionTitleInput(value: string) {
  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/[`*_#[\](){}<>|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s:;,.!?'"-]+|[\s:;,.!?'"-]+$/g, "");
  if (!normalized) {
    return undefined;
  }
  const chars = Array.from(normalized);
  return chars.length > 80 ? `${chars.slice(0, 77).join("")}...` : normalized;
}

export function selectedSessionModelFromConfig(config: GyroConfig) {
  const provider = providersForConfig(config).find(
    (item) => item.id === config.selectedProviderId,
  );
  const model = provider ? getProviderModel(provider) : undefined;
  return {
    providerId: provider?.id,
    providerLabel: provider?.displayName,
    modelId: model?.id ?? provider?.selectedModelId,
    modelLabel: model?.displayName ?? provider?.selectedModelId,
    reasoningEffort: provider ? selectedReasoningEffort(provider) : undefined,
  };
}

/** Model fields stored on a session, for per-pane composer binding. */
export function sessionModelSelectionFromSession(
  session?: Pick<
    Session,
    | "providerId"
    | "providerLabel"
    | "modelId"
    | "modelLabel"
    | "reasoningEffort"
  > | null,
): SessionModelSelection | undefined {
  if (!session?.providerId && !session?.modelId && !session?.modelLabel) {
    return undefined;
  }
  return {
    providerId:
      session.providerId && isProviderId(session.providerId)
        ? session.providerId
        : undefined,
    providerLabel: session.providerLabel,
    modelId: session.modelId,
    modelLabel: session.modelLabel,
    reasoningEffort: session.reasoningEffort,
  };
}

/**
 * Model a brand-new session opens on.
 *
 * Deliberately reads the provider's configured default rather than
 * `selectedModelId`: the latter tracks whichever session was last active, so
 * without this a new chat would silently inherit the previous thread's model
 * and the Settings default would never take effect.
 */
export function newSessionModelFromConfig(config: GyroConfig) {
  const provider = providersForConfig(config).find(
    (item) => item.id === config.selectedProviderId,
  );
  if (!provider) {
    return selectedSessionModelFromConfig(config);
  }
  const modelId = providerDefaultModelId(provider);
  const model = getProviderModel(provider, modelId);
  return {
    providerId: provider.id,
    providerLabel: provider.displayName,
    modelId: model?.id ?? modelId,
    modelLabel: model?.displayName ?? modelId,
    reasoningEffort:
      model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0],
  };
}

export const previewFiles: WorkspaceFile[] = [
  { path: "apps", kind: "directory", depth: 1 },
  { path: "apps/desktop", kind: "directory", depth: 2 },
  { path: "apps/desktop/src", kind: "directory", depth: 3 },
  { path: "apps/desktop/src/App.tsx", kind: "file", depth: 4 },
  { path: "apps/desktop/src-tauri", kind: "directory", depth: 3 },
  { path: "apps/desktop/src-tauri/src", kind: "directory", depth: 4 },
  {
    path: "apps/desktop/src-tauri/src/lib.rs",
    kind: "file",
    depth: 5,
  },
  { path: "crates", kind: "directory", depth: 1 },
  { path: "crates/gyro-core", kind: "directory", depth: 2 },
  { path: "crates/gyro-core/src", kind: "directory", depth: 3 },
  { path: "crates/gyro-core/src/sessions.rs", kind: "file", depth: 4 },
  { path: "docs", kind: "directory", depth: 1 },
  { path: "docs/architecture.md", kind: "file", depth: 2 },
  { path: "packages", kind: "directory", depth: 1 },
  { path: "packages/ui", kind: "directory", depth: 2 },
  { path: "packages/ui/src", kind: "directory", depth: 3 },
  { path: "packages/ui/src/styles.css", kind: "file", depth: 4 },
  { path: "packages/ui/src/surfaces.tsx", kind: "file", depth: 4 },
];

export function createPreviewWorkspaceFileContent(
  path: string,
): WorkspaceFileContent {
  const content = `// ${path}
// File preview is connected through the desktop workspace bridge.
// Open the Tauri app with a local workspace to read real file contents.`;
  return {
    path,
    content,
    contentHash: `preview-${content.length}`,
    truncated: false,
    sizeBytes: new TextEncoder().encode(content).length,
  };
}

export function createPreviewSession(
  layout: WorkspaceLayoutId,
  mode: WorkbenchState["workspaceMode"] = "local",
  model: Partial<
    Pick<
      Session,
      | "modelId"
      | "modelLabel"
      | "providerId"
      | "providerLabel"
      | "reasoningEffort"
    >
  > = {},
  workspacePath = "",
  titleOverride?: string,
  sessionId = `preview-${Date.now()}`,
): Session {
  const now = new Date().toISOString();
  const metadata = workspaceRunMetadata(mode, layout);
  const defaultTitle =
    layout === "terminal-grid"
      ? mode === "worktree"
        ? "Agent workspace CLI"
        : "CLI workspace"
      : mode === "worktree"
        ? "Agent workspace"
        : "Desktop session";
  return {
    id: sessionId,
    title: normalizeSessionTitleInput(titleOverride ?? "") ?? defaultTitle,
    workspacePath,
    origin: layout === "terminal-grid" ? "cli" : "desktop",
    workspaceMode: metadata.workspaceMode,
    branch: metadata.branch,
    worktreeName: metadata.worktreeName,
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    reasoningEffort: model.reasoningEffort,
    createdAt: now,
    updatedAt: now,
    eventsPath: "preview://events",
  };
}

export async function createTauriThreadSession(
  workspacePath: string | undefined,
  mode: WorkbenchState["workspaceMode"],
  model: ReturnType<typeof selectedSessionModelFromConfig>,
  titleOverride?: string,
): Promise<Session> {
  const workspace = workspacePath ?? "";
  const shouldCreateWorktree = mode === "worktree" && workspace.length > 0;
  const title =
    normalizeSessionTitleInput(titleOverride ?? "") ??
    (shouldCreateWorktree ? "Agent workspace" : "Desktop session");
  const metadata = workspaceRunMetadata(
    shouldCreateWorktree ? "worktree" : "local",
    `${title}-${Date.now()}`,
  );

  if (shouldCreateWorktree) {
    return invoke<Session>("create_worktree_session", {
      branch: metadata.branch,
      ...model,
      title,
      worktreeName: metadata.worktreeName,
      workspacePath: workspace,
    });
  }

  return invoke<Session>("create_desktop_session", {
    ...model,
    title,
    workspacePath: workspace,
  });
}

export function workspaceRunMetadata(
  mode: WorkbenchState["workspaceMode"],
  label: string,
  workingDirectory?: string,
) {
  if (mode === "local") {
    return { workspaceMode: mode, branch: "main", workingDirectory };
  }
  const slug = slugify(label || "task");
  return {
    workspaceMode: mode,
    branch: `gyro/${slug}`,
    worktreeName: `gyro-${slug}`,
    workingDirectory,
  };
}
