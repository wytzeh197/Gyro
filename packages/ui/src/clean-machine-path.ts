/**
 * Clean-machine activation path: open a project, connect a provider, then send.
 *
 * This is the product gate from ROADMAP launch blocker 3 and the v0.2 provider
 * setup exit criteria. Pure logic so the UI, smoke checks, and manual playbook
 * all agree on the same steps and blocked reasons.
 */

import { canSendChat, isUserSelectedWorkspacePath } from "./workbench-state.ts";
import type { ProviderId } from "./types";

export type CleanMachineStepId = "project" | "provider" | "ready";

export type CleanMachineStepStatus = "todo" | "active" | "done";

export type CleanMachineStep = {
  id: CleanMachineStepId;
  status: CleanMachineStepStatus;
  label: string;
  detail: string;
  action?: string;
  actionLabel?: string;
};

export type CleanMachinePath = {
  canSend: boolean;
  hasProject: boolean;
  hasReadyProvider: boolean;
  steps: CleanMachineStep[];
  blockedReason?: string;
  nextAction?: string;
  nextActionLabel?: string;
  /** Composer placeholder when send is blocked or ready. */
  placeholder: string;
  /** Short line for the composer readiness strip. */
  readinessLabel: string;
  readinessTone: "blocked" | "ready";
};

export type CleanMachinePathInput = {
  workspacePath?: string;
  /** Selected or session provider is connected and usable for a turn. */
  hasReadyProvider: boolean;
  /** Preferred provider to connect first on a clean machine. */
  preferredProviderId?: ProviderId;
  preferredProviderLabel?: string;
  /** Health summary when a selected provider is blocked. */
  providerBlockMessage?: string;
};

const DEFAULT_CONNECT_PROVIDER: ProviderId = "openai";
const DEFAULT_CONNECT_LABEL = "Codex";

/**
 * Resolve the clean-machine activation path from the current project and
 * provider readiness. Does not invent providers or claim readiness it was not
 * given.
 */
export function resolveCleanMachinePath(
  input: CleanMachinePathInput,
): CleanMachinePath {
  const hasProject = isUserSelectedWorkspacePath(input.workspacePath);
  const hasReadyProvider = input.hasReadyProvider === true;
  const canSend = canSendChat(hasReadyProvider, input.workspacePath);

  const connectProviderId = input.preferredProviderId ?? DEFAULT_CONNECT_PROVIDER;
  const connectLabel = input.preferredProviderLabel ?? DEFAULT_CONNECT_LABEL;
  const connectAction = `connect-provider:${connectProviderId}`;

  const projectStep: CleanMachineStep = hasProject
    ? {
        id: "project",
        status: "done",
        label: "Project open",
        detail: "Gyro will keep files, diffs, and approvals in this folder.",
      }
    : {
        id: "project",
        status: "active",
        label: "Open a project",
        detail: "Choose the local folder this chat is allowed to use.",
        action: "select-workspace",
        actionLabel: "Open project",
      };

  const providerStep: CleanMachineStep = hasReadyProvider
    ? {
        id: "provider",
        status: "done",
        label: "Provider ready",
        detail: "A local provider login is available for this chat.",
      }
    : {
        id: "provider",
        status: hasProject ? "active" : "todo",
        label: "Connect a provider",
        detail:
          input.providerBlockMessage?.trim() ||
          `Sign in with ${connectLabel} or another supported CLI. Gyro uses the provider's own login — no config file.`,
        action: connectAction,
        actionLabel: `Connect ${connectLabel}`,
      };

  const readyStep: CleanMachineStep = canSend
    ? {
        id: "ready",
        status: "done",
        label: "Ready to send",
        detail:
          "Describe a task. Commands and file edits still need your approval.",
      }
    : {
        id: "ready",
        status: "todo",
        label: "Send a first message",
        detail: hasProject
          ? "Connect a provider, then describe what you want done."
          : "Open a project and connect a provider first.",
      };

  let blockedReason: string | undefined;
  let nextAction: string | undefined;
  let nextActionLabel: string | undefined;
  let placeholder: string;
  let readinessLabel: string;

  if (!hasProject) {
    blockedReason = "Choose a project folder before sending.";
    nextAction = "select-workspace";
    nextActionLabel = "Open project";
    placeholder = "Open a project to start…";
    readinessLabel = "Choose a project folder to unlock send.";
  } else if (!hasReadyProvider) {
    blockedReason =
      input.providerBlockMessage?.trim() ||
      "Connect a local provider before sending.";
    nextAction = connectAction;
    nextActionLabel = `Connect ${connectLabel}`;
    placeholder = input.providerBlockMessage?.trim()
      ? `${connectLabel} needs attention — reconnect to send…`
      : `Connect ${connectLabel} to send a message…`;
    readinessLabel = blockedReason;
  } else {
    placeholder = "Describe a task or attach images";
    readinessLabel = "Project and provider ready. Approvals stay on for edits.";
  }

  return {
    canSend,
    hasProject,
    hasReadyProvider,
    steps: [projectStep, providerStep, readyStep],
    blockedReason,
    nextAction,
    nextActionLabel,
    placeholder,
    readinessLabel,
    readinessTone: canSend ? "ready" : "blocked",
  };
}

/** Providers that are the clean-machine first-connect targets. */
export const CLEAN_MACHINE_PRIMARY_PROVIDERS: ProviderId[] = [
  "openai",
  "anthropic",
];

/**
 * Pick which provider the "Connect" CTA should start when none is ready.
 * Prefers Codex, then Claude, then the first given executable id.
 */
export function preferredCleanMachineConnectProvider(
  candidates: Array<{ id: ProviderId; label: string; executable: boolean }>,
): { id: ProviderId; label: string } {
  const executable = candidates.filter((item) => item.executable);
  for (const id of CLEAN_MACHINE_PRIMARY_PROVIDERS) {
    const match = executable.find((item) => item.id === id);
    if (match) {
      return { id: match.id, label: match.label };
    }
  }
  const first = executable[0];
  if (first) {
    return { id: first.id, label: first.label };
  }
  return { id: DEFAULT_CONNECT_PROVIDER, label: DEFAULT_CONNECT_LABEL };
}
