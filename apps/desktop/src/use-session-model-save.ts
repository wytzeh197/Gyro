import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderId, ReasoningEffort, Session } from "@gyro-dev/ui";
import { isTauriRuntime } from "./tauri-runtime";

export type SessionModelSelection = {
  providerId?: ProviderId;
  providerLabel?: string;
  modelId?: string;
  modelLabel?: string;
  reasoningEffort?: ReasoningEffort;
};

export function useSessionModelSave({
  setSessions,
  refreshEvents,
  notify,
}: {
  setSessions: Dispatch<SetStateAction<Session[]>>;
  refreshEvents: (sessionId: string) => Promise<void>;
  notify: (kind: "command-failed", title: string, detail: string) => void;
}) {
  const queue = useRef(new Map<string, Promise<void>>());
  const saveSessionModel = useCallback(
    (sessionId: string, model: SessionModelSelection) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                providerId: model.providerId,
                providerLabel: model.providerLabel,
                modelId: model.modelId,
                modelLabel: model.modelLabel,
                reasoningEffort: model.reasoningEffort,
              }
            : session,
        ),
      );

      if (!isTauriRuntime()) return Promise.resolve();

      // Preserve the order of quick model changes and an immediate send.
      const previous = queue.current.get(sessionId) ?? Promise.resolve();
      const task = previous
        .catch(() => {})
        .then(async () => {
          try {
            const updated = await invoke<Session>("set_session_model", {
              sessionId,
              providerId: model.providerId,
              providerLabel: model.providerLabel,
              modelId: model.modelId,
              modelLabel: model.modelLabel,
              reasoningEffort: model.reasoningEffort,
            });
            if (queue.current.get(sessionId) === task) {
              setSessions((current) =>
                current.map((session) =>
                  session.id === sessionId ? updated : session,
                ),
              );
            }
            await refreshEvents(sessionId);
          } catch {
            notify(
              "command-failed",
              "Model memory failed",
              "This chat kept the model in the current window only",
            );
          }
        });
      queue.current.set(sessionId, task);
      void task.then(() => {
        if (queue.current.get(sessionId) === task)
          queue.current.delete(sessionId);
      });
      return task;
    },
    [notify, refreshEvents, setSessions],
  );
  const pendingModelSave = useCallback(
    (sessionId: string) => queue.current.get(sessionId),
    [],
  );
  return { saveSessionModel, pendingModelSave };
}
