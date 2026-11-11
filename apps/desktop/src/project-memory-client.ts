import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ProjectMemoryRuntime,
  MemorySnapshot,
  MemorySettings,
  MemoryReceipt,
  MemoryCandidate,
} from "@gyro-dev/ui";

const clients = new Map<string, ProjectMemoryRuntime>();
export function projectMemoryClient(sessionId: string): ProjectMemoryRuntime {
  const cached = clients.get(sessionId);
  if (cached) return cached;
  const request = <T>(action: string, rootId?: string, payload?: unknown) =>
    invoke<T>("project_memory_request", { sessionId, rootId, action, payload });
  const client: ProjectMemoryRuntime = {
    key: sessionId,
    list: (rootId, query, offset) =>
      request<MemorySnapshot>("list", rootId, { query, offset }),
    save: (rootId, expectedHash, draft, id) =>
      request("save", rootId, { expectedHash, draft, id }),
    forget: (rootId, expectedHash, id) =>
      request("forget", rootId, { expectedHash, id }),
    settings: (rootId, settings) =>
      request<MemorySettings>("settings", rootId, settings),
    receipts: () => request<MemoryReceipt[]>("receipts"),
    candidates: (rootId) => request<MemoryCandidate[]>("candidates", rootId),
    accept: (rootId, expectedHash, candidate, draft) =>
      request("accept", rootId, {
        expectedHash,
        candidateId: candidate.id,
        revision: candidate.revision,
        draft,
      }),
    dismiss: (rootId, candidate) =>
      request("dismiss", rootId, {
        candidateId: candidate.id,
        revision: candidate.revision,
      }),
    subscribe: (callback) => {
      let disposed = false;
      const subscription = listen("gyro://project-memory-changed", () => {
        if (!disposed) callback();
      });
      window.addEventListener("focus", callback);
      return () => {
        disposed = true;
        window.removeEventListener("focus", callback);
        void subscription.then((stop) => stop());
      };
    },
  };
  clients.set(sessionId, client);
  if (clients.size > 32) clients.delete(clients.keys().next().value!);
  return client;
}
