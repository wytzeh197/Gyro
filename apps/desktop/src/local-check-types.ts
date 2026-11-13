export type CheckScope = "api" | "browser" | "command";
export type BrowserRead = {
  key: string;
  selector: string;
  kind: "text" | "texts" | "count" | "height";
};
export type BrowserStep =
  | { action: "fill"; selector: string; text: string }
  | { action: "click"; selector: string }
  | {
      action: "observe";
      criterionId: string;
      reads: BrowserRead[];
      waitMs: number;
    };
export type BrowserCheck = {
  readySelector: string;
  viewport?: { width: number; height: number };
  steps: BrowserStep[];
};
export type CheckCriterion = {
  id: string;
  requirement: string;
  expected: unknown;
  scope: CheckScope | "unspecified";
};
export type CheckDraft = {
  sessionId: string;
  task?: { sourceTurnId: string; previousPlanId?: string };
  previewUrl: string;
  command: string;
  browser?: BrowserCheck | null;
  dataChanges: string;
  files: string[];
  criteria: CheckCriterion[];
};
export type CheckPlan = {
  id: string;
  createdAt: string;
  workspaceRevision: number;
  draft: CheckDraft;
  snapshot: {
    workspace: string;
    gitHead?: string;
    files: { path: string; sha256: string }[];
  };
};
export type CheckReport = {
  plan: CheckPlan;
  finishedAt: string;
  results: {
    criterionId: string;
    status: "passed" | "failed" | "not-checked";
    actual?: unknown;
    evidence?: string;
    reason: string;
    observedScope?: CheckScope | "unspecified" | null;
  }[];
  output?: {
    termination: { kind: string; code?: number };
    stdout: string;
    stderr: string;
    durationMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  stale: boolean;
  freshnessNote: string;
  omission: string;
};
