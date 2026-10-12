// Keep this renderer's chat identity outside WebKit's protected drag store.
export const CHAT_SESSION_DRAG_MIME = "application/x-gyro-chat-session";
export const CHAT_PANE_DRAG_MIME = "application/x-gyro-chat-pane";
const CHAT_DRAG_ID_MIME = "application/x-gyro-chat-drag-id";
const MAX_ID_LENGTH = 512;
const MAX_PROJECT_LENGTH = 16_384;
// JSON escapes quotes/backslashes, so every valid source remains readable.
const MAX_PAYLOAD_LENGTH = (MAX_PROJECT_LENGTH + MAX_ID_LENGTH) * 2 + 128;
const rendererDragPrefix =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export type ChatSessionDragPayload = Readonly<{
  sessionId: string;
  projectKey: string;
}>;
export type ChatPaneDragPayload = Readonly<{ paneId: string }>;
export type ChatDragPayload =
  | (ChatSessionDragPayload & { readonly kind: "session" })
  | (ChatPaneDragPayload & { readonly kind: "pane" });
export type ActiveChatDrag = ChatDragPayload & {
  readonly dragId: number;
  readonly inputMode?: "pointer";
};
export type ChatDragTransfer = Pick<DataTransfer, "getData"> &
  Partial<Pick<DataTransfer, "types" | "files" | "items" | "setData">>;

let nextDragId = 0;
let activeDrag: ActiveChatDrag | undefined;
const listeners = new Set<(drag: ActiveChatDrag | undefined) => void>();
let lifecycleWindow: Window | undefined;

function notify() {
  for (const listener of Array.from(listeners)) {
    // One detached subscriber must not prevent the remaining grids cleaning up.
    try {
      listener(activeDrag);
    } catch {
      // The drag lifecycle must still finish if its source has unmounted.
    }
  }
}

/** Subscribe to both drag starts and cancellations; immediately report state. */
export function subscribeChatDrag(
  listener: (drag: ActiveChatDrag | undefined) => void,
) {
  listeners.add(listener);
  listener(activeDrag);
  return () => {
    listeners.delete(listener);
  };
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ID_LENGTH &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function sessionPayload(value: unknown): ChatSessionDragPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const payload = value as Record<string, unknown>;
  if (
    !validIdentity(payload.sessionId) ||
    typeof payload.projectKey !== "string" ||
    payload.projectKey.length > MAX_PROJECT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(payload.projectKey)
  )
    return;
  return Object.freeze({
    sessionId: payload.sessionId,
    projectKey: payload.projectKey,
  });
}

function installLifecycle() {
  if (typeof window === "undefined" || lifecycleWindow === window) return;
  lifecycleWindow = window;
  // Capture runs before the new source's React dragstart handler. Every new
  // native drag invalidates the previous fallback, including non-chat drags.
  window.addEventListener(
    "dragstart",
    () => {
      if (activeDrag?.inputMode !== "pointer") endChatDrag();
    },
    true,
  );
  const observeIncomingDrag = (event: DragEvent) => {
    const drag = activeDrag;
    if (!drag || drag.inputMode === "pointer" || !event.dataTransfer) return;
    if (explicitNonChatDrag(describe(event.dataTransfer)))
      endChatDrag(drag.dragId);
  };
  // An external file/text drag starts outside this window, so dragstart cannot
  // clear a stranded fallback. Its visible unrelated data proves a new drag.
  window.addEventListener("dragenter", observeIncomingDrag, true);
  window.addEventListener("dragover", observeIncomingDrag, true);
  const finishNativeDrag = (event: DragEvent) => {
    const drag = activeDrag;
    if (
      !drag ||
      drag.inputMode === "pointer" ||
      (event.dataTransfer && !matchesActiveDrag(describe(event.dataTransfer)))
    )
      return;
    // Drop handlers still need the protected identity. Clear after dispatch,
    // even when a child stops bubbling or its handler throws.
    queueMicrotask(() => endChatDrag(drag.dragId));
  };
  window.addEventListener("drop", finishNativeDrag, true);
  window.addEventListener("dragend", finishNativeDrag, true);
  window.addEventListener("blur", () => endChatDrag());
  window.addEventListener("pagehide", () => endChatDrag());
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") endChatDrag();
    },
    true,
  );
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") endChatDrag();
    });
  }
}

function beginDrag(
  payload: ChatDragPayload,
  transfer?: ChatDragTransfer,
  inputMode?: "pointer",
) {
  installLifecycle();
  const drag = Object.freeze({
    ...payload,
    dragId: ++nextDragId,
    ...(inputMode ? { inputMode } : {}),
  });
  activeDrag = drag;
  // A protected or failing native writer must not strand the in-app identity.
  // Never put chat ids in text/plain, where a composer could insert them.
  if (transfer) {
    try {
      transfer.setData?.(
        payload.kind === "pane" ? CHAT_PANE_DRAG_MIME : CHAT_SESSION_DRAG_MIME,
        payload.kind === "pane"
          ? payload.paneId
          : JSON.stringify({
              sessionId: payload.sessionId,
              projectKey: payload.projectKey,
            }),
      );
      transfer.setData?.(CHAT_DRAG_ID_MIME, nativeDragId(drag));
    } catch {
      // WebKit can keep the store protected after a source DOM change.
    }
  }
  notify();
  return drag;
}

export function beginChatSessionDrag(
  payload: ChatSessionDragPayload,
  transfer?: ChatDragTransfer,
): ActiveChatDrag | undefined {
  const value = sessionPayload(payload);
  if (!value) {
    endChatDrag();
    return;
  }
  return beginDrag({ kind: "session", ...value }, transfer);
}

export function beginChatPaneDrag(
  payload: ChatPaneDragPayload,
  transfer?: ChatDragTransfer,
): ActiveChatDrag | undefined {
  if (!validIdentity(payload?.paneId)) {
    endChatDrag();
    return;
  }
  return beginDrag({ kind: "pane", paneId: payload.paneId }, transfer);
}

/** Internal gestures keep their identity through pointer capture, not WebKit. */
export function beginChatPointerDrag(
  payload: ChatDragPayload,
): ActiveChatDrag | undefined {
  if (payload.kind === "session") {
    const value = sessionPayload(payload);
    if (value)
      return beginDrag({ kind: "session", ...value }, undefined, "pointer");
  } else if (validIdentity(payload.paneId)) {
    return beginDrag(
      { kind: "pane", paneId: payload.paneId },
      undefined,
      "pointer",
    );
  }
  endChatDrag();
  return undefined;
}

/** A previous source's late dragend must not cancel a newer drag. */
export function endChatDrag(dragId?: number) {
  if (!activeDrag || (dragId !== undefined && activeDrag.dragId !== dragId))
    return;
  activeDrag = undefined;
  notify();
}

export function currentChatDrag() {
  return activeDrag;
}

/** Consume this transfer without cancelling a newer, unrelated chat drag. */
export function endChatDragForTransfer(
  transfer: ChatDragTransfer | null | undefined,
) {
  if (!transfer || !activeDrag) return;
  if (matchesActiveDrag(describe(transfer))) endChatDrag(activeDrag.dragId);
}

// Retained for callers that only deal with sidebar sessions.
export function endChatSessionDrag(sessionId?: string) {
  if (
    !sessionId ||
    (activeDrag?.kind === "session" && activeDrag.sessionId === sessionId)
  )
    endChatDrag();
}
export function currentChatSessionDrag(): ChatSessionDragPayload | undefined {
  return activeDrag?.kind === "session"
    ? Object.freeze({
        sessionId: activeDrag.sessionId,
        projectKey: activeDrag.projectKey,
      })
    : undefined;
}

function safeData(transfer: ChatDragTransfer, type: string) {
  try {
    const value = transfer.getData(type);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function transferTypes(transfer: ChatDragTransfer): string[] | undefined {
  try {
    const types = transfer.types;
    if (!types) return;
    // WebKit's DOMStringList has indexed items/contains rather than includes.
    const list = types as unknown as {
      length: number;
      readonly [index: number]: string | undefined;
      item?: (index: number) => string | null;
      contains?: (type: string) => boolean;
    };
    if (!Number.isInteger(list.length) || list.length < 0 || list.length > 256)
      return;
    const result: string[] = [];
    for (let index = 0; index < list.length; index++) {
      const value = list[index] ?? list.item?.(index);
      if (typeof value === "string") result.push(value.toLowerCase());
    }
    // Also support DOMStringList implementations exposing only contains.
    for (const type of [
      CHAT_SESSION_DRAG_MIME,
      CHAT_PANE_DRAG_MIME,
      CHAT_DRAG_ID_MIME,
      "Files",
    ]) {
      try {
        if (list.contains?.(type) && !result.includes(type.toLowerCase()))
          result.push(type.toLowerCase());
      } catch {
        // Preserve indexed type evidence if contains is unavailable.
      }
    }
    return result;
  } catch {
    return;
  }
}

function containsFiles(
  transfer: ChatDragTransfer,
  types: string[] | undefined,
) {
  if (types?.includes("files")) return true;
  try {
    if (transfer.files?.length) return true;
  } catch {
    // Inspect items separately: some WebKit stores only protect files.
  }
  try {
    const items = transfer.items;
    if (items) {
      for (let index = 0; index < items.length; index++) {
        if (items[index]?.kind === "file") return true;
      }
    }
  } catch {
    // A protected store can hide files as well as custom data.
  }
  return false;
}

function describe(transfer: ChatDragTransfer) {
  const types = transferTypes(transfer);
  const session = safeData(transfer, CHAT_SESSION_DRAG_MIME);
  const pane = safeData(transfer, CHAT_PANE_DRAG_MIME);
  const dragId = safeData(transfer, CHAT_DRAG_ID_MIME);
  return {
    types,
    session,
    pane,
    dragId,
    hasFiles: containsFiles(transfer, types),
    hasDragId: !!dragId || !!types?.includes(CHAT_DRAG_ID_MIME),
    hasOtherData:
      !session &&
      !pane &&
      ["text/plain", "text/uri-list", "text/html"].some(
        (type) => !!safeData(transfer, type),
      ),
    hasSession: !!session || !!types?.includes(CHAT_SESSION_DRAG_MIME),
    hasPane: !!pane || !!types?.includes(CHAT_PANE_DRAG_MIME),
  };
}

type TransferDescription = ReturnType<typeof describe>;

function explicitNonChatDrag(transfer: TransferDescription) {
  // Old chat events and protected empty stores cannot cancel the current drag.
  if (transfer.hasSession || transfer.hasPane || transfer.hasDragId)
    return false;
  return transfer.hasFiles || transfer.hasOtherData || !!transfer.types?.length;
}

function nativeDragId(drag: ActiveChatDrag) {
  return `${rendererDragPrefix}:${drag.dragId}`;
}

function staleOwnedDrag(transfer: TransferDescription) {
  return (
    transfer.dragId.startsWith(`${rendererDragPrefix}:`) &&
    (!activeDrag || transfer.dragId !== nativeDragId(activeDrag))
  );
}

function matchesActiveDrag(transfer: TransferDescription) {
  if (
    !activeDrag ||
    activeDrag.inputMode === "pointer" ||
    transfer.hasFiles ||
    transfer.hasOtherData
  )
    return false;
  if (transfer.dragId && transfer.dragId !== nativeDragId(activeDrag))
    return false;
  if (transfer.hasSession && transfer.hasPane) return false;
  if (activeDrag.kind === "session" ? transfer.hasPane : transfer.hasSession)
    return false;
  // Explicit non-chat data belongs to another drag. Empty or unreadable types
  // may belong to this renderer's still-running protected WebKit drag.
  if (
    !transfer.hasSession &&
    !transfer.hasPane &&
    !transfer.hasDragId &&
    transfer.types?.length
  )
    return false;
  if (transfer.session) {
    const payload = parseSession(transfer.session);
    return (
      activeDrag.kind === "session" &&
      payload?.sessionId === activeDrag.sessionId &&
      payload.projectKey === activeDrag.projectKey
    );
  }
  if (transfer.pane)
    return activeDrag.kind === "pane" && transfer.pane === activeDrag.paneId;
  return true;
}

function parseSession(raw: string) {
  if (raw.length > MAX_PAYLOAD_LENGTH) return;
  try {
    return sessionPayload(JSON.parse(raw));
  } catch {
    return;
  }
}

/** Recognize chat MIME even when malformed, so ids cannot fall into an input. */
export function chatDragSource(transfer: ChatDragTransfer | null | undefined) {
  if (!transfer) return;
  const value = describe(transfer);
  if (matchesActiveDrag(value)) return activeDrag?.kind;
  if (value.hasPane) return "pane" as const;
  if (value.hasSession) return "session" as const;
  // A surviving token still identifies a chat transfer for interception, even
  // when its original MIME has disappeared. It never creates an identity.
  if (value.hasDragId) return "session" as const;
  return;
}

export function readChatDrag(
  transfer: ChatDragTransfer | null | undefined,
): ChatDragPayload | ActiveChatDrag | undefined {
  if (!transfer) return;
  const value = describe(transfer);
  if (
    value.hasFiles ||
    staleOwnedDrag(value) ||
    (value.hasSession && value.hasPane)
  )
    return;
  if (matchesActiveDrag(value)) return activeDrag;
  if (value.session) {
    const payload = parseSession(value.session);
    return payload ? Object.freeze({ kind: "session", ...payload }) : undefined;
  }
  // The grid must additionally verify that a pane still exists in its layout.
  if (validIdentity(value.pane))
    return Object.freeze({ kind: "pane", paneId: value.pane });
  return;
}

export function readChatSessionDrag(
  transfer: ChatDragTransfer,
): ChatSessionDragPayload | undefined {
  const payload = readChatDrag(transfer);
  return payload?.kind === "session"
    ? Object.freeze({
        sessionId: payload.sessionId,
        projectKey: payload.projectKey,
      })
    : undefined;
}
