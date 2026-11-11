export type MemoryKind =
  "decision" | "convention" | "command" | "open-problem" | "note";
export type MemorySource =
  | { kind: "user-entered" }
  | {
      kind: "project-file";
      path: string;
      contentHash: string;
      lines?: [number, number];
    }
  | { kind: "commit"; oid: string; path?: string };
export type MemoryEntry = {
  id: string;
  text: string;
  date: string;
  kind: MemoryKind;
  status: "active" | "superseded" | "invalid";
  sourceChanged: boolean;
  entryHash: string;
  paths: string[];
  sources: MemorySource[];
  supersedes?: string;
};
export type MemoryDraft = Pick<
  MemoryEntry,
  "text" | "kind" | "paths" | "sources" | "supersedes"
>;
export type MemorySettings = {
  enabled: boolean;
  suggestions: boolean;
  maxBytes: number;
  maxEntries: number;
};
export type MemorySnapshot = {
  rootId: string;
  roots: { id: string; path: string }[];
  documentHash: string | null;
  entries: MemoryEntry[];
  total: number;
  nextOffset?: number;
  diagnostics: { entryId?: string; line: number; message: string }[];
  settings: MemorySettings;
};
export type MemoryReceipt = {
  turnId: string;
  providerId: string;
  receipt: {
    suppliedBytes: number;
    estimatedTokens: number;
    reusedCount: number;
    delta: boolean;
    removedKeys: string[];
    roots: {
      rootId: string;
      documentHash: string;
      omittedCount: number;
      entries: { id: string; key: string; entryHash: string }[];
    }[];
  };
};
export type ProjectMemoryRuntime = {
  key: string;
  list: (
    rootId?: string,
    query?: string,
    offset?: number,
  ) => Promise<MemorySnapshot>;
  save: (
    rootId: string,
    expectedHash: string | null,
    draft: MemoryDraft,
    id?: string,
  ) => Promise<unknown>;
  forget: (
    rootId: string,
    expectedHash: string | null,
    id: string,
  ) => Promise<unknown>;
  settings: (
    rootId: string,
    settings: MemorySettings,
  ) => Promise<MemorySettings>;
  receipts: () => Promise<MemoryReceipt[]>;
  candidates: (rootId?: string) => Promise<MemoryCandidate[]>;
  accept: (
    rootId: string,
    expectedHash: string | null,
    candidate: MemoryCandidate,
    draft: MemoryDraft,
  ) => Promise<unknown>;
  dismiss: (rootId: string, candidate: MemoryCandidate) => Promise<unknown>;
  subscribe: (callback: () => void) => () => void;
};
export type MemoryCandidate = {
  id: string;
  revision: number;
  status: "pending" | "accepting" | "accepted" | "dismissed";
  draft: MemoryDraft | null;
  evidenceQuote: string | null;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceEventId: string;
};
