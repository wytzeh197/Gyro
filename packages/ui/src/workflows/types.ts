export type WorkflowInput = {
  id: string;
  label: string;
  type: "string" | "boolean" | "enum" | "url" | "path";
  required: boolean;
  options?: string[];
};
export type WorkflowStep =
  | {
      id: string;
      kind: "agent";
      role: string;
      instructions: string;
      requestedAccess: "read-only" | "workspace";
      output: { name: string; required: boolean };
    }
  | {
      id: string;
      kind: "review";
      role: string;
      sourceStep: string;
      instructions: string;
    }
  | {
      id: string;
      kind: "verification";
      commandRef: string;
      instructions: string;
    };
export type WorkflowDefinition = {
  schema: "gyro.workflow.v1";
  id: string;
  name: string;
  description: string;
  inputs: WorkflowInput[];
  roles: string[];
  steps: WorkflowStep[];
  completion: {
    requiredOutputs: string[];
    requireReviewCompletion: boolean;
    requireVerificationSuccess: boolean;
  };
};
export type WorkflowBinding = {
  definitionId: string;
  definitionHash: string;
  roles: Record<
    string,
    {
      providerId: string;
      modelId: string;
      accessCeiling: "read-only" | "workspace";
    }
  >;
  commands: Record<
    string,
    {
      program: string;
      args: string[];
      taskId?: string;
      taskFingerprint?: string;
    }
  >;
  inputs: Record<string, string | boolean>;
};
export type WorkflowProject = {
  sessionId: string;
  rootId: string;
  title: string;
  path: string;
};
export type WorkflowListing = {
  path: string;
  definition?: WorkflowDefinition | null;
  hash?: string | null;
  diagnostic?: string | null;
};
export type WorkflowLibrary = {
  rootId: string;
  roots: { id: string; path: string }[];
  definitions: WorkflowListing[];
};
export type WorkflowSetup = {
  rootId: string;
  roots: { id: string; path: string }[];
  providers: {
    id: string;
    label: string;
    enabled: boolean;
    reviewAvailable: boolean;
    transport: "API" | "CLI" | "local";
    modelIds: string[];
  }[];
  tasks: {
    id: string;
    label: string;
    command: string;
    args: string[];
    fingerprint: string;
  }[];
};
export type WorkflowStepAttempt = {
  stepId: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "waiting"
    | "failed"
    | "cancelled"
    | "interrupted";
  sessionId?: string;
  turnId?: string;
  reviewId?: string;
  output?: string;
  error?: string;
  verificationPassed?: boolean;
  reviewCompleted?: boolean;
  openFindings: number;
};
export type WorkflowRun = {
  usage?: import("../feature-usage").FeatureUsage;
  previousRunId?: string;
  id: string;
  revision: number;
  operationId: string;
  automationId?: string;
  sourceSessionId: string;
  rootId: string;
  rootKey: string;
  origin: string;
  definition: WorkflowDefinition;
  binding: WorkflowBinding;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  steps: WorkflowStepAttempt[];
  requirementsMet?: boolean;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};
export type WorkflowJob = {
  id: string;
  title: string;
  schedule: string;
  status: "current" | "paused" | "completed";
  updatedAt: string;
  nextRunAt?: string;
  lastResult: string;
  leaseOwner?: string;
  runHistory: {
    id: string;
    sessionId?: string;
    status: string;
    summary: string;
  }[];
  execution: {
    workspacePath?: string;
    calendar?: { timezone: string; time: string };
    workflowBinding: {
      sourceSessionId: string;
      rootId: string;
      definition: WorkflowDefinition;
      binding: WorkflowBinding;
    };
  };
};
export type WorkflowDraft = {
  id: string;
  revision: number;
  sourceSessionId: string;
  rootId: string;
  sourceTurnIds: string[];
  sourceComplete: boolean;
  captureHash: string;
  capturedBytes: number;
  status:
    | "preview"
    | "queued"
    | "running"
    | "ready"
    | "failed"
    | "interrupted"
    | "cancelled";
  extractionSessionId?: string;
  providerId?: string;
  modelId?: string;
  definition?: WorkflowDefinition;
  error?: string;
  createdAt: string;
};
export type WorkflowSourceTurn = {
  turnId: string;
  eventId: string;
  request: string;
  status?: string;
  hasAnswer: boolean;
};
export type WorkflowRuntime = {
  key: string;
  definition<T>(
    action: string,
    sessionId: string,
    rootId?: string,
    payload?: unknown,
  ): Promise<T>;
  run<T>(
    action: string,
    payload?: unknown,
    sessionId?: string,
    rootId?: string,
  ): Promise<T>;
  extraction<T>(
    action: string,
    payload?: unknown,
    sessionId?: string,
    rootId?: string,
  ): Promise<T>;
  subscribe(callback: () => void): () => void;
};
export type WorkflowExtractionRequest = {
  token: number;
  sessionId: string;
  turnId?: string;
};

export type WorkflowRunSummary = Omit<
  WorkflowRun,
  "binding" | "definition" | "steps"
> & {
  definition: Pick<WorkflowDefinition, "id" | "name" | "description">;
  steps: Omit<WorkflowStepAttempt, "output">[];
};
