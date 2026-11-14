import type { WorkspaceScopedSettings } from "./types";

export const WORKSPACE_WORD_WRAP_VALUES = ["off", "on", "bounded"] as const;
export const WORKSPACE_RENDER_WHITESPACE_VALUES = [
  "none",
  "boundary",
  "selection",
  "trailing",
  "all",
] as const;
export const WORKSPACE_AUTO_SAVE_VALUES = [
  "off",
  "afterDelay",
  "onFocusChange",
] as const;

export type WorkspaceEditorSettings = Pick<
  WorkspaceScopedSettings,
  | "editorFontSize"
  | "editorTabSize"
  | "editorInsertSpaces"
  | "editorWordWrap"
  | "editorRulers"
  | "editorRenderWhitespace"
  | "editorFormatOnSave"
  | "editorBreadcrumbs"
  | "filesAutoSave"
  | "filesAutoSaveDelay"
>;

export const defaultWorkspaceEditorSettings: Required<WorkspaceEditorSettings> =
  {
    editorFontSize: 13.5,
    editorTabSize: 2,
    editorInsertSpaces: true,
    editorWordWrap: "off",
    editorRulers: [],
    editorRenderWhitespace: "selection",
    editorFormatOnSave: false,
    editorBreadcrumbs: true,
    filesAutoSave: "off",
    filesAutoSaveDelay: 1000,
  };

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  round: (value: number) => number = Math.round,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, round(value)))
    : undefined;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]) {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Shared by user settings and `.gyro-workspace` files, so both accept the same values. */
export function normalizedWorkspaceEditorSettings(
  record: Record<string, unknown>,
): WorkspaceEditorSettings {
  const settings: WorkspaceEditorSettings = {
    editorFontSize: boundedNumber(
      record.editorFontSize,
      8,
      32,
      (value) => Math.round(value * 2) / 2,
    ),
    editorTabSize: boundedNumber(record.editorTabSize, 1, 8),
    editorInsertSpaces:
      typeof record.editorInsertSpaces === "boolean"
        ? record.editorInsertSpaces
        : undefined,
    editorWordWrap: oneOf(record.editorWordWrap, WORKSPACE_WORD_WRAP_VALUES),
    editorRulers: Array.isArray(record.editorRulers)
      ? [
          ...new Set(
            record.editorRulers.flatMap((column) => {
              const value = boundedNumber(column, 1, 500);
              return value === undefined ? [] : [value];
            }),
          ),
        ]
          .sort((a, b) => a - b)
          .slice(0, 8)
      : undefined,
    editorRenderWhitespace: oneOf(
      record.editorRenderWhitespace,
      WORKSPACE_RENDER_WHITESPACE_VALUES,
    ),
    editorFormatOnSave:
      typeof record.editorFormatOnSave === "boolean"
        ? record.editorFormatOnSave
        : undefined,
    editorBreadcrumbs:
      typeof record.editorBreadcrumbs === "boolean"
        ? record.editorBreadcrumbs
        : undefined,
    filesAutoSave: oneOf(record.filesAutoSave, WORKSPACE_AUTO_SAVE_VALUES),
    filesAutoSaveDelay: boundedNumber(record.filesAutoSaveDelay, 100, 60_000),
  };
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as WorkspaceEditorSettings;
}

/** "80, 120" → [80, 120]; blank → undefined so the scope inherits. */
export function workspaceRulerList(value: string) {
  if (!value.trim()) return undefined;
  return normalizedWorkspaceEditorSettings({
    editorRulers: value
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number),
  }).editorRulers;
}
