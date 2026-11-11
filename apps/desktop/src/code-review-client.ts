import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodeReviewRuntime } from "@gyro-dev/ui";
const clients = new Map<string, CodeReviewRuntime>();
export function codeReviewClient(sessionId: string): CodeReviewRuntime {
  const cached = clients.get(sessionId);
  if (cached) return cached;
  const client: CodeReviewRuntime = {
    key: sessionId,
    request: <T>(action: string, payload?: unknown, rootId?: string) =>
      invoke<T>("code_review_request", { sessionId, rootId, action, payload }),
    subscribe: (callback) => {
      let disposed = false;
      const subscription = listen<{ sourceSessionId: string }>(
        "gyro://code-review-changed",
        (event) => {
          if (!disposed && event.payload.sourceSessionId === sessionId)
            callback();
        },
      );
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
