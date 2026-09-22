import { createContext, useContext } from "react";

/**
 * Where a terminal-output attachment came from, so the transcript can offer to
 * run that command again once the model has made its fix. Kept by the desktop
 * shell rather than in the stored message, which only records the attachment.
 */
export type TerminalAttachmentActions = {
  canRerun: (attachmentId: string) => boolean;
  rerun: (attachmentId: string) => void;
};

export const TerminalAttachmentActionsContext = createContext<
  TerminalAttachmentActions | undefined
>(undefined);

export function useTerminalAttachmentActions() {
  return useContext(TerminalAttachmentActionsContext);
}
