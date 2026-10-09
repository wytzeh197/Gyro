// Invented, development-only data for visual QA. Never reads local transcripts
// or starts an import. Production import behavior stays in use-project-import.
import type { ProjectImportSettingsProps } from "@gyro-dev/ui";

export function projectImportPreview(
  state: string,
  report: (message: string) => void,
): ProjectImportSettingsProps {
  const sources: ProjectImportSettingsProps["sources"] = [
    {
      kind: "claude-code",
      label: "Claude Code",
      dataHome: "/Users/dev/.claude",
      available: true,
    },
    {
      kind: "codex",
      label: "Codex",
      dataHome: "/Users/dev/.codex",
      available: true,
    },
  ];
  const candidates: NonNullable<
    ProjectImportSettingsProps["scan"]
  >["candidates"] = [
    {
      id: "fixture-1",
      sourceKind: "claude-code",
      sourceSessionId: "source-1",
      dataHome: sources[0]!.dataHome,
      transcriptPath: "/fixture/claude.jsonl",
      workspacePath: "/Users/dev/Projects/aurora",
      title: "Bound the sync queue retries",
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-07T10:00:00Z",
      archived: false,
      workspaceAvailable: true,
      eventCount: 24,
      diagnostics: [],
    },
    {
      id: "fixture-2",
      sourceKind: "codex",
      sourceSessionId: "source-2",
      dataHome: sources[1]!.dataHome,
      transcriptPath: "/fixture/codex.jsonl",
      workspacePath: "/Users/dev/Projects/aurora",
      title: "Review the parser boundaries",
      createdAt: "2026-10-02T09:00:00Z",
      updatedAt: "2026-10-07T08:00:00Z",
      archived: false,
      workspaceAvailable: true,
      eventCount: 16,
      diagnostics: [],
    },
    {
      id: "fixture-3",
      sourceKind: "codex",
      sourceSessionId: "source-3",
      dataHome: sources[1]!.dataHome,
      transcriptPath: "/fixture/moved.jsonl",
      workspacePath: "/Users/dev/Archive/long-project-name",
      title: "Investigate a moved workspace",
      createdAt: "2026-09-20T09:00:00Z",
      updatedAt: "2026-10-03T08:00:00Z",
      archived: false,
      workspaceAvailable: false,
      eventCount: 8,
      diagnostics: ["Project folder is no longer available."],
    },
  ];
  return {
    sources,
    loadingSources: state === "loading",
    scanning: state === "scanning",
    includeArchived: false,
    error:
      state === "error"
        ? "Could not read the selected transcript folder."
        : undefined,
    scan: ["scanned", "running", "completed"].includes(state)
      ? { scanId: "fixture-scan", sources, candidates, diagnostics: [] }
      : undefined,
    job:
      state === "running" || state === "completed"
        ? {
            id: "fixture-job",
            status: state,
            total: 2,
            completed: state === "completed" ? 2 : 1,
            results: candidates
              .slice(0, state === "completed" ? 2 : 1)
              .map((item) => ({
                candidateId: item.id,
                title: item.title,
                workspacePath: item.workspacePath,
                sessionId: `imported-${item.id}`,
                status: "imported" as const,
                diagnostics: [],
              })),
          }
        : undefined,
    onIncludeArchivedChange: () =>
      report("Development preview: archived selection changed."),
    onChooseDataFolder: () =>
      report("Development preview: no folder picker opened."),
    onScan: () => report("Development preview: no transcripts scanned."),
    onImport: () => report("Development preview: no chats imported."),
    onCancel: () => report("Development preview: no job cancelled."),
    onOpenSession: () => report("Development preview: no session opened."),
    onLocateFolder: () => report("Development preview: no folder relocated."),
    onRetry: () => report("Development preview: no import retried."),
  };
}
