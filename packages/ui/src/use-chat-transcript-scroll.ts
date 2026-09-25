import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type TouchEvent,
  type UIEvent,
  type WheelEvent,
} from "react";
import type { SessionEvent } from "./types";

const BOTTOM_SLACK = 72;
const LOAD_EARLIER_SLACK = 96;
const OVERFLOW_SLACK = 8;

function isLoadedTranscriptClipped(transcript: HTMLElement) {
  const styles = window.getComputedStyle(transcript);
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const loadEarlier = transcript.querySelector(".gyro-chat-load-earlier");
  const loadEarlierHeight =
    loadEarlier instanceof HTMLElement ? loadEarlier.offsetHeight : 0;
  const messageHeight = Math.max(
    0,
    transcript.scrollHeight - paddingTop - paddingBottom - loadEarlierHeight,
  );
  const visibleAboveDock = Math.max(0, transcript.clientHeight - paddingBottom);
  return messageHeight > visibleAboveDock + OVERFLOW_SLACK;
}

export function useChatTranscriptScroll({
  events,
  hasMoreBefore,
  isLoadingEarlier,
  onLoadEarlier,
  liveChangesTarget,
}: {
  events: SessionEvent[];
  hasMoreBefore: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier?: () => void;
  liveChangesTarget: HTMLDivElement | null;
}) {
  const [isTranscriptAwayFromBottom, setIsTranscriptAwayFromBottom] =
    useState(false);
  const [isLoadedChatClipped, setIsLoadedChatClipped] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const isFollowingBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const pointerDownRef = useRef(false);
  const touchYRef = useRef<number>();
  const upwardIntentRef = useRef(false);
  const requestedEarlierCursorRef = useRef<string>();
  const pendingEarlierScrollRef = useRef<{
    sessionId?: string;
    cursorId: string;
    scrollHeight: number;
    scrollTop: number;
  }>();
  const sessionId = events[0]?.sessionId;

  const updateScrollPosition = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      setIsTranscriptAwayFromBottom(false);
      setIsLoadedChatClipped(false);
      return;
    }
    const distanceFromBottom =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    const isAtBottom = distanceFromBottom <= BOTTOM_SLACK;
    if (isAtBottom) {
      isFollowingBottomRef.current = true;
    } else if (
      pointerDownRef.current &&
      transcript.scrollTop < lastScrollTopRef.current
    ) {
      isFollowingBottomRef.current = false;
    }
    lastScrollTopRef.current = transcript.scrollTop;
    setIsTranscriptAwayFromBottom(!isAtBottom);
    setIsLoadedChatClipped(isLoadedTranscriptClipped(transcript));
  }, []);

  const requestEarlierMessages = useCallback(
    (manual = false) => {
      const transcript = transcriptRef.current;
      const cursorId = events.find(
        (event) => event.kind !== "session-created",
      )?.id;
      if (
        !transcript ||
        !cursorId ||
        !hasMoreBefore ||
        isLoadingEarlier ||
        !onLoadEarlier ||
        !isLoadedTranscriptClipped(transcript)
      ) {
        return;
      }
      if (
        !manual &&
        (!upwardIntentRef.current ||
          transcript.scrollTop > LOAD_EARLIER_SLACK ||
          requestedEarlierCursorRef.current === cursorId)
      ) {
        return;
      }
      requestedEarlierCursorRef.current = cursorId;
      upwardIntentRef.current = false;
      pendingEarlierScrollRef.current = {
        sessionId,
        cursorId,
        scrollHeight: transcript.scrollHeight,
        scrollTop: transcript.scrollTop,
      };
      isFollowingBottomRef.current = false;
      onLoadEarlier();
    },
    [events, hasMoreBefore, isLoadingEarlier, onLoadEarlier, sessionId],
  );

  const pinToBottom = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !isFollowingBottomRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
    lastScrollTopRef.current = transcript.scrollTop;
  }, []);
  const scrollTranscriptToBottom = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    isFollowingBottomRef.current = true;
    lastScrollTopRef.current = transcript.scrollTop;
    pinToBottom();
    updateScrollPosition();
  }, [pinToBottom, updateScrollPosition]);

  useLayoutEffect(() => {
    isFollowingBottomRef.current = true;
    upwardIntentRef.current = false;
    requestedEarlierCursorRef.current = undefined;
    pendingEarlierScrollRef.current = undefined;
    lastScrollTopRef.current = 0;
    pinToBottom();
    updateScrollPosition();
  }, [sessionId, pinToBottom, updateScrollPosition]);
  useLayoutEffect(() => {
    const anchor = pendingEarlierScrollRef.current;
    if (!anchor || anchor.sessionId !== sessionId) return;
    const earliestEventId = events.find(
      (event) => event.kind !== "session-created",
    )?.id;
    if (earliestEventId === anchor.cursorId) return;
    pendingEarlierScrollRef.current = undefined;
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop =
      anchor.scrollTop + transcript.scrollHeight - anchor.scrollHeight;
    lastScrollTopRef.current = transcript.scrollTop;
    updateScrollPosition();
  }, [events, sessionId, updateScrollPosition]);
  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      pinToBottom();
      updateScrollPosition();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [pinToBottom, events, updateScrollPosition]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    const dock = liveChangesTarget?.parentElement;
    if (!transcript || typeof ResizeObserver === "undefined") return;
    const updateDockClearance = () => {
      if (dock) {
        const dockBounds = dock.getBoundingClientRect();
        const composer = dock.querySelector<HTMLElement>(
          ":scope > .gyro-composer-shell",
        );
        const composerHeight = `${Math.ceil(
          dockBounds.bottom -
            (composer?.getBoundingClientRect().top ?? dockBounds.top),
        )}px`;
        transcript.style.setProperty(
          "--gyro-composer-dock-height",
          `${Math.ceil(dockBounds.height)}px`,
        );
        dock.style.setProperty("--gyro-composer-solid-height", composerHeight);
      }
      pinToBottom();
      updateScrollPosition();
    };
    updateDockClearance();
    let resizeFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== undefined) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined;
        updateDockClearance();
      });
    });
    observer.observe(transcript);
    for (const child of transcript.children) observer.observe(child);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element) observer.unobserve(node);
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) observer.observe(node);
        }
      }
    });
    mutations.observe(transcript, { childList: true });
    const releasePointer = () => {
      pointerDownRef.current = false;
    };
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    if (dock) observer.observe(dock);
    return () => {
      mutations.disconnect();
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
      observer.disconnect();
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
    };
  }, [liveChangesTarget, pinToBottom, updateScrollPosition]);

  const onTranscriptScroll = (event: UIEvent<HTMLDivElement>) => {
    if (
      pointerDownRef.current &&
      event.currentTarget.scrollTop < lastScrollTopRef.current
    ) {
      upwardIntentRef.current = true;
    }
    updateScrollPosition();
    requestEarlierMessages();
  };
  const onTranscriptWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      isFollowingBottomRef.current = false;
      upwardIntentRef.current = true;
      requestEarlierMessages();
    }
  };
  const onTranscriptTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY;
  };
  const onTranscriptTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (
      y !== undefined &&
      touchYRef.current !== undefined &&
      y > touchYRef.current
    ) {
      isFollowingBottomRef.current = false;
      upwardIntentRef.current = true;
      requestEarlierMessages();
    }
    touchYRef.current = y;
  };
  const onTranscriptKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
      (event.key === " " && event.shiftKey)
    ) {
      isFollowingBottomRef.current = false;
      upwardIntentRef.current = true;
      requestEarlierMessages();
    }
  };

  return {
    transcriptRef,
    isTranscriptAwayFromBottom,
    isLoadedChatClipped,
    requestEarlierMessages,
    scrollTranscriptToBottom,
    onTranscriptScroll,
    onTranscriptWheel,
    onTranscriptTouchStart,
    onTranscriptTouchMove,
    onTranscriptKeyDown,
    onTranscriptPointerDown: () => {
      pointerDownRef.current = true;
    },
  };
}
