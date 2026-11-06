import type { WorkspaceTrustDecision } from "./types";

export function normalizedWorkspaceTrustPath(path: string) {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function workspaceTrustDecision(
  decisions: Readonly<Record<string, WorkspaceTrustDecision>> | undefined,
  path?: string,
): WorkspaceTrustDecision | undefined {
  if (!path) return undefined;
  return decisions?.[normalizedWorkspaceTrustPath(path)] ?? "trusted";
}

export function isWorkspaceTrusted(
  decisions: Readonly<Record<string, WorkspaceTrustDecision>> | undefined,
  path?: string,
) {
  return workspaceTrustDecision(decisions, path) !== "restricted";
}
