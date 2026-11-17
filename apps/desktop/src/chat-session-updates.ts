import type { Session } from "@gyro-dev/ui";

/** Brief storage contention should recover; persistent failures reach the UI. */
export async function readChatSessionList<T>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt === 2) throw error;
      await wait(250 * (attempt + 1));
    }
  }
}

/** Completion owns response metadata, not a model chosen after its snapshot. */
export function mergeCompletedChatSession(
  current: Session,
  completed: Session,
): Session {
  return {
    ...completed,
    providerId: current.providerId,
    providerLabel: current.providerLabel,
    modelId: current.modelId,
    modelLabel: current.modelLabel,
    reasoningEffort: current.reasoningEffort,
  };
}

export type ChatResourcePayload = { sessionId: string; data: unknown };
type ChatResourceCache = Record<string, ChatResourcePayload>;
const MAX_RESOURCE_PAYLOADS = 256;

export function retainChatResourcePayload(
  current: ChatResourceCache,
  callId: string,
  sessionId: string,
  data: unknown,
): ChatResourceCache {
  const entries = Object.entries(current).filter(([id]) => id !== callId);
  return Object.fromEntries([
    ...entries.slice(-(MAX_RESOURCE_PAYLOADS - 1)),
    [callId, { sessionId, data }],
  ]);
}

export function forgetChatResourcePayloads(
  current: ChatResourceCache,
  callIds: Set<string>,
): ChatResourceCache {
  return Object.fromEntries(
    Object.entries(current).filter(([id]) => !callIds.has(id)),
  );
}

/** Resource events can arrive without an activity event; retain their owner directly. */
export function forgetChatSessionResources(
  current: ChatResourceCache,
  sessionId: string,
): ChatResourceCache {
  return Object.fromEntries(
    Object.entries(current).filter(
      ([, value]) => value.sessionId !== sessionId,
    ),
  );
}
