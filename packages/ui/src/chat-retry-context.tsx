import { createContext } from "react";

export type ChatRetryState = {
  /** Actual deadlines owned by the host, keyed by the failed status event. */
  pending: Record<string, { retryAt: number }>;
  /** Cancels the scheduled attempt; the turn remains available to retry. */
  cancel: (eventId: string) => void;
};

export const ChatRetryContext = createContext<ChatRetryState>({
  pending: {},
  cancel: () => {},
});
