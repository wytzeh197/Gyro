import { invoke } from "@tauri-apps/api/core";
import type { BrowserTraceRuntime } from "@gyro-dev/ui";

export function browserTraceRuntime(
  session:
    | {
        id: string;
        workspaceIdentity?: {
          roots: BrowserTraceRuntime["roots"];
          activeRootId: string;
        };
      }
    | undefined,
  openEditor: (path: string, line: number) => void,
): BrowserTraceRuntime | undefined {
  if (!session?.workspaceIdentity?.roots.length) return undefined;
  const sessionId = session.id;
  return {
    sessionId,
    roots: session.workspaceIdentity.roots,
    activeRootId: session.workspaceIdentity.activeRootId,
    start: (setup) => invoke("browser_trace_start", { sessionId, setup }),
    active: () => invoke("browser_trace_active", { sessionId }),
    status: (traceId) => invoke("browser_trace_status", { sessionId, traceId }),
    discard: (traceId) =>
      invoke("browser_trace_discard", { sessionId, traceId }),
    review: (traceId, eventIds, locations) =>
      invoke("browser_trace_review", {
        sessionId,
        traceId,
        eventIds,
        locations,
      }),
    analyze: (traceId, reviewId) =>
      invoke("browser_trace_analyze", { sessionId, traceId, reviewId }),
    history: () => invoke("browser_trace_history", { sessionId }),
    async openSource(traceId, excerptId, line) {
      const path = await invoke<string | null>("browser_trace_source", {
        sessionId,
        traceId,
        excerptId,
        line,
      });
      if (!path) return false;
      openEditor(path, line);
      return true;
    },
  };
}
