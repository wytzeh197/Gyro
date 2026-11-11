export type CodeReviewScope =
  | { kind: "uncommitted" }
  | { kind: "branch"; base: string }
  | { kind: "turn"; turnId: string };
export type CodeReviewStatus =
  | "queued"
  | "capturing"
  | "running"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";
export type CodeReviewFinding = {
  id: string;
  revision: number;
  path: string;
  side: "original" | "modified";
  lineStart: number;
  lineEnd: number;
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  explanation: string;
  suggestedResolution?: string;
  disposition:
    | "open"
    | "sent-for-fix"
    | "fix-claimed"
    | "resolved-by-review"
    | "dismissed";
};
export type CodeReviewRun = {
  id: string;
  revision: number;
  rootId: string;
  snapshotId: string;
  status: CodeReviewStatus;
  providerId: string;
  modelId: string;
  createdAt: string;
  finishedAt?: string;
  previousReviewId?: string;
  summary?: string;
  error?: string;
  findings: CodeReviewFinding[];
  limitations: string[];
  suppliedFiles: number;
  intendedFiles: number;
};
export type CodeReviewSnapshot = {
  rootPath?: string;
  headOid?: string;
  baseOid?: string;
  id: string;
  rootId: string;
  scope: CodeReviewScope;
  request: string;
  capturedAt: string;
  capturedBytes: number;
  manifestHash: string;
  files: {
    path: string;
    status: string;
    originalHash?: string;
    modifiedHash?: string;
  }[];
  exclusions: { path: string; reason: string }[];
};
export type Reviewer = {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  transport: string;
  modelIds: string[];
  defaultModelId?: string;
};
export type ReviewerSetup = {
  rootId: string;
  roots: { id: string; path: string }[];
  reviewers: Reviewer[];
};
export type CodeReviewDetail = {
  usage?: import("../feature-usage").FeatureUsage;
  fixTarget?: { providerId?: string; modelId?: string };
  fixIntents?: {
    id: string;
    revision: number;
    status: string;
    turnId: string;
    providerId: string;
    modelId: string;
    error?: string;
  }[];
  run: CodeReviewRun;
  snapshot: CodeReviewSnapshot;
  freshness: string;
  targetFingerprint?: string;
};
/** Native owns authority, capture, providers, persistence and freshness. */
export type CodeReviewRuntime = {
  key: string;
  request<T>(action: string, payload?: unknown, rootId?: string): Promise<T>;
  subscribe(callback: () => void): () => void;
};
export const reviewIsActive = (status: CodeReviewStatus) =>
  ["queued", "capturing", "running"].includes(status);

export type CodeReviewEntryRequest = {
  token: number;
  rootId?: string;
  scope: CodeReviewScope;
  paths?: string[];
};
