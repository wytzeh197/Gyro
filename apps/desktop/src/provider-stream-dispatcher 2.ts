import type { ProviderChatStreamEvent } from "@gyro-dev/ui";
import {
  flushExpiredProviderStreamGaps,
  nextProviderStreamGapDeadline,
  orderProviderChatStreamEvent,
  type ProviderStreamOrderState,
} from "./provider-stream-events";

type RecoveryClock = {
  now: () => number;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
};

/** One timer covers all chats. No interval runs when every stream is ordered. */
export function createProviderStreamDispatcher(
  state: ProviderStreamOrderState,
  dispatch: (event: ProviderChatStreamEvent) => void,
  clock: RecoveryClock = {
    now: () => performance.now(),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
) {
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    const deadline = nextProviderStreamGapDeadline(state);
    if (deadline === undefined) return;
    timer = clock.setTimer(
      () => {
        timer = undefined;
        for (const event of flushExpiredProviderStreamGaps(state, clock.now()))
          dispatch(event);
        schedule();
      },
      Math.max(0, deadline - clock.now()),
    );
  };
  return {
    push(event: ProviderChatStreamEvent) {
      for (const accepted of orderProviderChatStreamEvent(
        state,
        event,
        clock.now(),
      ))
        dispatch(accepted);
      schedule();
    },
    dispose() {
      if (timer !== undefined) clock.clearTimer(timer);
      timer = undefined;
    },
  };
}
