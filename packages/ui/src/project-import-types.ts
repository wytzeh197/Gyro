/** Local provider transcript imports. Candidate IDs are issued by the backend scan. */
export type ProjectImportSourceKind = "claude-code" | "codex";

export interface ProjectImportSource {
  kind: ProjectImportSourceKind;
  label: string;
  dataHome: string;
  available: boolean;
  detail?: string;
}

export interface SessionImportSource {
  sourceKind: ProjectImportSourceKind;
  sourceSessionId: string;
  dataHome: string;
  transcriptPath: string;
  importedAt: string;
  freshSessionRequested?: boolean;
}

export interface ProjectImportCandidate {
  id: string;
  sourceKind: ProjectImportSourceKind;
  sourceSessionId: string;
  dataHome: string;
  transcriptPath: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
  archived: boolean;
  workspaceAvailable: boolean;
  eventCount: number;
  diagnostics: string[];
  existingSessionId?: string;
}

export interface ProjectImportScan {
  scanId: string;
  sources: ProjectImportSource[];
  candidates: ProjectImportCandidate[];
  diagnostics: string[];
}

export interface ProjectImportResult {
  candidateId: string;
  title: string;
  workspacePath: string;
  sessionId?: string;
  status: "imported" | "existing" | "failed";
  detail?: string;
  diagnostics: string[];
}

export interface ProjectImportJob {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  total: number;
  completed: number;
  results: ProjectImportResult[];
  error?: string;
}
