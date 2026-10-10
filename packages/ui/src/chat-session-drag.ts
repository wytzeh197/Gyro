// Keep in-app chat identity outside WebKit's protected drag data store.
export const CHAT_SESSION_DRAG_MIME = "application/x-gyro-chat-session";
export type ChatSessionDragPayload = { sessionId: string; projectKey: string };
let activeDrag: ChatSessionDragPayload | undefined;

export function beginChatSessionDrag(payload: ChatSessionDragPayload) {
  activeDrag = payload;
}
export function endChatSessionDrag(sessionId?: string) {
  if (!sessionId || activeDrag?.sessionId === sessionId) activeDrag = undefined;
}
export function currentChatSessionDrag() {
  return activeDrag;
}
export function readChatSessionDrag(
  transfer: Pick<DataTransfer, "getData">,
): ChatSessionDragPayload | undefined {
  // This renderer's sidebar is authoritative throughout its own drag. WebKit
  // can hide both custom types and bytes, even on a drop after a DOM change.
  if (activeDrag) return activeDrag;
  try {
    const raw = transfer.getData(CHAT_SESSION_DRAG_MIME);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const payload = value as Record<string, unknown>;
    return typeof payload.sessionId === "string" && payload.sessionId
      ? { sessionId: payload.sessionId,
          projectKey: typeof payload.projectKey === "string" ? payload.projectKey : "" }
      : undefined;
  } catch {
    return undefined;
  }
}
