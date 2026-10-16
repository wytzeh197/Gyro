import type { SystemAccessScope } from "@gyro-dev/ui";
import "./dictation-access";

export const SYSTEM_ACCESS_STATUS_STORAGE_KEY = "gyro.system-access-status-v1";

// A display snapshot, never an authorization decision. macOS still enforces access.
export function parseSystemAccessSnapshot(
  raw: string | undefined,
): SystemAccessScope[] {
  if (!raw) return [];
  try {
    const scopes: unknown = JSON.parse(raw);
    if (!Array.isArray(scopes) || scopes.length > 5) return [];
    const ids = new Set([
      "desktop",
      "documents",
      "downloads",
      "removable-volumes",
      "full-disk",
    ]);
    const statuses = new Set([
      "granted",
      "denied",
      "unavailable",
      "unsupported",
    ]);
    const seen = new Set<string>();
    for (const value of scopes) {
      if (!value || typeof value !== "object") return [];
      const scope = value as Record<string, unknown>;
      if (
        typeof scope.id !== "string" ||
        !ids.has(scope.id) ||
        seen.has(scope.id) ||
        typeof scope.status !== "string" ||
        !statuses.has(scope.status) ||
        typeof scope.label !== "string" ||
        typeof scope.reason !== "string" ||
        typeof scope.canPrompt !== "boolean" ||
        typeof scope.settingsUrl !== "string" ||
        (scope.path !== undefined && typeof scope.path !== "string")
      )
        return [];
      seen.add(scope.id);
    }
    return scopes as SystemAccessScope[];
  } catch {
    return [];
  }
}
