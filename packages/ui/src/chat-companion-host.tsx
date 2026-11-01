import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { chatPaneTranscriptMinimum } from "./chat-companion";

type CompanionLayout = {
  width: string;
  overlay: boolean;
  expanded: boolean;
};
type PaneEntry = { present?: boolean; layout?: CompanionLayout };

type PaneHost = {
  paneId: string;
  number: number;
  /** The pane holding the user's attention; only it may move keyboard focus. */
  isFocused: boolean;
  isTiled: boolean;
  /** Reading width the conversation keeps beside its own panel. */
  transcriptReserve: number;
  /** The pane frame holding the chat and its panel; the panel sizes against it. */
  frameRef: MutableRefObject<HTMLDivElement | null>;
  target: HTMLDivElement | null;
  sourceRef: MutableRefObject<HTMLDivElement | null>;
  updatePane: (paneId: string, entry?: PaneEntry) => void;
  restoreFocus: (paneId: string, source: HTMLDivElement | null) => void;
};
type PaneRail = {
  attach: (element: HTMLDivElement | null) => void;
  present: boolean;
  overlay: boolean;
  expanded: boolean;
  width?: string;
};

const PaneContext = createContext<PaneHost | undefined>(undefined);
const RailContext = createContext<PaneRail | undefined>(undefined);

/** Lays out the chat grid; every pane frames its own panel. */
export function ChatCompanionWorkspace({
  children,
  isTiled,
}: {
  children: ReactNode;
  isTiled: boolean;
}) {
  return (
    <div className={["gyro-chat-workspace", isTiled ? "is-tiled" : ""].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

/**
 * Each chat pane owns one panel inside its own frame, so split chats keep
 * their tools side by side. A stable portal target keeps a tool and its drafts
 * mounted while the pane moves between grid slots.
 */
export function ChatCompanionPaneScope({
  children,
  paneId,
  number,
  isFocused,
  isTiled,
}: {
  children: ReactNode;
  paneId: string;
  number: number;
  isFocused: boolean;
  isTiled: boolean;
}) {
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [entry, setEntry] = useState<PaneEntry>();
  const [focusRequest, setFocusRequest] = useState<{
    source: HTMLDivElement | null;
  }>();
  const [target] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  const attach = useCallback((node: HTMLDivElement | null) => {
    frameRef.current = (node?.parentElement as HTMLDivElement | null) ?? null;
    setElement(node);
  }, []);
  useLayoutEffect(() => {
    if (!target || !element) return;
    element.append(target);
    return () => target.remove();
  }, [target, element]);
  useLayoutEffect(() => {
    if (!target) return;
    target.className = "gyro-chat-companion-host-pane is-active";
    target.dataset.paneId = paneId;
  }, [target, paneId]);
  const updatePane = useCallback((_paneId: string, update?: PaneEntry) => {
    setEntry((previous) => {
      if (!update) return undefined;
      if (!previous && update.present === false && !update.layout)
        return previous;
      const next = { ...previous, ...update };
      if (
        previous?.present === next.present &&
        previous?.layout?.width === next.layout?.width &&
        previous?.layout?.overlay === next.layout?.overlay &&
        previous?.layout?.expanded === next.layout?.expanded
      )
        return previous;
      return next;
    });
  }, []);
  const restoreFocus = useCallback(
    (_paneId: string, source: HTMLDivElement | null) =>
      setFocusRequest({ source }),
    [],
  );
  const present = entry?.present === true;
  const overlay = entry?.layout?.overlay === true;
  const expanded = entry?.layout?.expanded === true;
  const covered = present && (overlay || expanded);
  useLayoutEffect(() => {
    // A panel spread across its pane covers that chat only; split neighbours
    // stay usable.
    const surface = sourceRef.current;
    if (!surface) return;
    if (covered && surface.contains(document.activeElement)) {
      element
        ?.querySelector<HTMLElement>(".gyro-chat-companion-host-pane button")
        ?.focus({ preventScroll: true });
    }
    surface.inert = covered;
    if (covered) surface.setAttribute("aria-hidden", "true");
    else surface.removeAttribute("aria-hidden");
    return () => {
      surface.inert = false;
      surface.removeAttribute("aria-hidden");
    };
  }, [element, covered]);
  useLayoutEffect(() => {
    // A closing full-width panel keeps the chat inert through its exit.
    // Restore the opener only after that cover is gone.
    if (!focusRequest || covered) return;
    if (focusRequest.source?.isConnected) {
      focusRequest.source
        .querySelector<HTMLElement>(
          '.gyro-chat-surface-controls button[aria-label="Show companion"]',
        )
        ?.focus({ preventScroll: true });
    }
    setFocusRequest(undefined);
  }, [focusRequest, covered]);
  const context = useMemo<PaneHost>(
    () => ({
      paneId,
      number,
      isFocused,
      isTiled,
      transcriptReserve: chatPaneTranscriptMinimum(isTiled),
      frameRef,
      target,
      sourceRef,
      updatePane,
      restoreFocus,
    }),
    [paneId, number, isFocused, isTiled, target, updatePane, restoreFocus],
  );
  const rail = useMemo<PaneRail>(
    () => ({ attach, present, overlay, expanded, width: entry?.layout?.width }),
    [attach, present, overlay, expanded, entry?.layout?.width],
  );
  return (
    <PaneContext.Provider value={context}>
      <RailContext.Provider value={rail}>{children}</RailContext.Provider>
    </PaneContext.Provider>
  );
}

/** The panel column inside a pane frame, beside the conversation. */
export function ChatCompanionPaneRail() {
  const rail = useContext(RailContext);
  if (!rail) return null;
  return (
    <div
      className={[
        "gyro-chat-companion-host",
        rail.overlay ? "is-overlay" : "",
        rail.expanded ? "is-expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      hidden={!rail.present}
      ref={rail.attach}
      style={{
        width: rail.present
          ? (rail.width ?? (rail.overlay ? "100%" : "420px"))
          : "0px",
      }}
    />
  );
}

export function useChatCompanionHost() {
  return useContext(PaneContext);
}

export function SharedChatCompanion({ children }: { children: ReactNode }) {
  const host = useChatCompanionHost();
  const present = Boolean(children);
  const updatePane = host?.updatePane;
  const paneId = host?.paneId;
  useLayoutEffect(() => {
    if (!paneId || !updatePane) return;
    updatePane(paneId, { present });
    return () => updatePane(paneId, { present: false });
  }, [paneId, updatePane, present]);
  return host?.target ? createPortal(children, host.target) : children;
}

export function useSharedCompanionLayout(layout: CompanionLayout) {
  const host = useChatCompanionHost();
  const updatePane = host?.updatePane;
  const paneId = host?.paneId;
  useLayoutEffect(() => {
    if (paneId && updatePane) updatePane(paneId, { layout });
  }, [paneId, updatePane, layout.width, layout.overlay, layout.expanded]);
  useLayoutEffect(
    () => () => {
      if (paneId && updatePane) updatePane(paneId, { layout: undefined });
    },
    [paneId, updatePane],
  );
}
