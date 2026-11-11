import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WorkflowRuntime } from "@gyro-dev/ui";
export const workflowClient: WorkflowRuntime = {
  key: "native-workflows",
  definition: <T>(
    action: string,
    sessionId: string,
    rootId?: string,
    payload?: unknown,
  ) =>
    invoke<T>("workflow_definition_request", {
      sessionId,
      rootId,
      action,
      payload,
    }),
  run: <T>(
    action: string,
    payload?: unknown,
    sessionId?: string,
    rootId?: string,
  ) =>
    invoke<T>("workflow_run_request", { sessionId, rootId, action, payload }),
  extraction: <T>(
    action: string,
    payload?: unknown,
    sessionId?: string,
    rootId?: string,
  ) =>
    invoke<T>("workflow_extraction_request", {
      sessionId,
      rootId,
      action,
      payload,
    }),
  subscribe: (callback) => {
    let disposed = false;
    const subscriptions = [
      "gyro://workflow-definitions-changed",
      "gyro://workflow-run-changed",
      "gyro://workflow-draft-changed",
      "gyro://automation-updated",
    ].map((name) =>
      listen(name, () => {
        if (!disposed) callback();
      }),
    );
    window.addEventListener("focus", callback);
    return () => {
      disposed = true;
      window.removeEventListener("focus", callback);
      subscriptions.forEach(
        (subscription) => void subscription.then((stop) => stop()),
      );
    };
  },
};
